import { appendFileSync, mkdirSync, existsSync, readFileSync,
         writeFileSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexBuildOptIn, testHooksBuildOptIn, verboseBuild } from "./buildflags";

/** Headless-diagnosable debug log. One timestamped JSONL line per event, from
 *  BOTH the extension host (src:"ext") and the injected webview block
 *  (src:"webview", relayed through the loopback /log route). Written to a
 *  fixed server-side path so a headless agent / CI / Docker run can read the
 *  whole lifecycle with no human watching a screen.
 *
 *  LOGGING POLICY (two tiers):
 *   - Lifecycle events (auth / self-update / activation health — see
 *     `isLifecycleEvent`) ALWAYS log, even in a stock install. They are
 *     low-volume and PII-free, and make incidents like a failed silent
 *     token-refresh-on-update diagnosable from ANY user's machine without
 *     asking them to flip a flag first. The rolling trim (MAX_LOG_LINES)
 *     keeps the file bounded.
 *   - The verbose firehose (per-impression metrics, webview relay via
 *     `dlogRaw`, render plumbing) stays OFF by default (prime directive: no
 *     overhead in normal use) and is opt-in via EITHER `KICKBACKS_DEBUG`
 *     (or `VIBE_ADS_DEBUG`) truthy OR a `~/.vibe-ads/debug.enabled` sentinel
 *     — the sentinel is the headless toggle (create/remove from a shell, no
 *     rebuild, no UI).
 *  Never throws. */
const DIR = join(homedir(), ".vibe-ads");
const LOG = join(DIR, "debug.log");
const SENTINEL = join(DIR, "debug.enabled");
const CONFIG = join(DIR, "config.json");

// Short cache so dlog (called often, gated by debugEnabled()) doesn't
// readFileSync the config on every event. Saving config.json restarts the
// extension host anyway (config watcher in extension.ts), so TTL is belt-
// and-suspenders — the cache will be torn down before it can go stale.
let _cfgCheckedAt = 0;
let _cfgDebug = false;
function configSaysDebug(): boolean {
  const now = Date.now();
  if (now - _cfgCheckedAt < 5000) return _cfgDebug;
  _cfgCheckedAt = now;
  try {
    const raw = readFileSync(CONFIG, "utf8");
    _cfgDebug = (JSON.parse(raw) as { debugMode?: unknown })?.debugMode === true;
  } catch { _cfgDebug = false; /* absent or malformed -> off */ }
  return _cfgDebug;
}

export function debugEnabled(): boolean {
  try {
    // Build-time verbose flag (esbuild define).
    if (verboseBuild()) return true;
    // Env-var opt-in: both legacy and new prefixes.
    if (process.env.KICKBACKS_DEBUG === "1"
        || process.env.VIBE_ADS_DEBUG === "1") return true;
    // Sentinel file: ~/.vibe-ads/debug.enabled.
    if (existsSync(SENTINEL)) return true;
    // Config JSON: debugMode: true.
    return configSaysDebug();
  } catch { return false; }
}

// S9 Codex dual-target opt-in. PRODUCTION DEFAULT IS OFF on machines running
// a compatible Claude Code (prime directive: it crashed Claude Code once and
// the dual-install path is not yet manually smoke-verified). This only
// enables Codex auto-discovery for an explicit opt-in: `VIBE_ADS_CODEX=1`
// OR a `~/.vibe-ads/codex.enabled` sentinel — the sentinel is the headless,
// no-relaunch toggle for smoke-testing (create/remove from a shell, reload).
// Never throws. Do NOT widen this to a default-on until smoke + a
// can't-crash-CC verification both pass.
//
// NOTE: this is the raw opt-IN only. The CLAUDE-INCOMPATIBLE FALLBACK (Codex
// discovery turns on by itself when no compatible Claude Code target exists —
// there is nothing of ours to crash on such a machine) is composed in
// extension.ts via activation/codexFallback.codexDiscoveryEnabled(), where
// both preflights are visible. codexDisabled() below beats both.
const CODEX_SENTINEL = join(DIR, "codex.enabled");
export function codexEnabled(): boolean {
  try {
    if (codexBuildOptIn()) return true;
    if (process.env.KICKBACKS_CODEX === "1"
        || process.env.VIBE_ADS_CODEX === "1") return true;
    return existsSync(CODEX_SENTINEL);
  } catch { return false; }
}

// Explicit local opt-OUT for Codex targeting. Beats BOTH the opt-in above and
// the claude-incompatible fallback (composed in extension.ts). KICKBACKS_CODEX=0
// / VIBE_ADS_CODEX=0, or a ~/.vibe-ads/codex.disabled sentinel — the headless
// one-liner support remediation (create from a shell, reload, done). Never
// throws.
const CODEX_DISABLED_SENTINEL = join(DIR, "codex.disabled");
export function codexDisabled(): boolean {
  try {
    if (process.env.KICKBACKS_CODEX === "0"
        || process.env.VIBE_ADS_CODEX === "0") return true;
    return existsSync(CODEX_DISABLED_SENTINEL);
  } catch { return false; }
}

// Codex CLI wrapper opt-in. PRODUCTION DEFAULT IS OFF — replacing the
// npm-generated codex.cmd is reversible but high-blast-radius (every
// `codex` invocation on the box) so it must be flipped on explicitly:
// VIBE_ADS_CODEX_CLI=1 OR a ~/.vibe-ads/codex-cli.enabled sentinel.
// Mirrors the codexEnabled() gate pattern. Never throws.
const CODEX_CLI_SENTINEL = join(DIR, "codex-cli.enabled");
export function codexCliEnabled(): boolean {
  try {
    if (process.env.KICKBACKS_CODEX_CLI === "1"
        || process.env.VIBE_ADS_CODEX_CLI === "1") return true;
    return existsSync(CODEX_CLI_SENTINEL);
  } catch { return false; }
}

// E2E test-hook surface (kickbacks.test.* commands). OFF by default: a stock
// install must never expose forge-click commands in the command palette. Two
// opt-ins, mirroring the debug/codex pattern: env VIBE_ADS_TEST_HOOKS truthy,
// or a ~/.vibe-ads/test-hooks.enabled sentinel for headless toggling. Never
// throws — if the filesystem read fails, the hooks stay disabled.
const TEST_HOOKS_SENTINEL = join(DIR, "test-hooks.enabled");
export function testHooksEnabled(): boolean {
  try {
    if (testHooksBuildOptIn()) return true;
    if ((process.env.KICKBACKS_TEST_HOOKS || process.env.VIBE_ADS_TEST_HOOKS)
        && (process.env.KICKBACKS_TEST_HOOKS || process.env.VIBE_ADS_TEST_HOOKS) !== "0")
      return true;
    return existsSync(TEST_HOOKS_SENTINEL);
  } catch { return false; }
}

// E2E-only advertiser-icon override. The closed-loop e2e (test-stack/e2e)
// screenshot-verifies that a custom advertiser icon (the `data:` URI the
// backend inlines from GCS — see the CSP/data-URI icon fix) actually renders
// in the spinner overlay, NOT just the inline-"K" fallback. The debug-
// injection ad is icon-less by default, so this env var lets the harness feed
// a known inline icon to the debug ad. HARD-GATED to `data:image/...` URIs
// only — never an external URL — so there is zero SSRF/exfiltration surface
// and production (which never sets this var) is completely unaffected. Returns
// "" when unset or not a data:image URI, in which case the ad renders the "K"
// fallback exactly as before. Never throws.
export function debugIconDataUri(): string {
  try {
    const v = process.env.KICKBACKS_E2E_ICON_DATA_URI
      || process.env.VIBE_ADS_E2E_ICON_DATA_URI || "";
    return /^data:image\//i.test(v) ? v : "";
  } catch { return ""; }
}

// Rolling-trim configuration. Without this the log grows unbounded — a
// long-lived session can produce thousands of view_tick lines an hour and
// the file becomes unwieldy for grep + slow for the `/debug_logs`
// monitors. Keep the last MAX_LOG_LINES lines; check every N writes so
// the hot path stays append-only.
export const MAX_LOG_LINES = 1000;
const TRIM_CHECK_INTERVAL = 50;        // writes between size checks
const TRIM_MIN_BYTES = 64 * 1024;      // skip the read if file is small enough
let _writesSinceCheck = 0;

/** Sliding-window trim: if the log has more than MAX_LOG_LINES lines,
 *  drop the oldest until the count is back at MAX_LOG_LINES. Throttled
 *  via a counter so dlog() stays append-only most of the time.
 *
 *  Writes directly to LOG via `writeFileSync` (overwrite-in-place). An
 *  earlier version used `temp + renameSync` for atomicity, but the
 *  rename fails on Windows whenever ANY process holds a handle to
 *  LOG — including VS Code's editor when the user opens debug.log to
 *  read it, OR a `tail -F` in another terminal. Symptom was a stuck
 *  `debug.log.trimming` temp file at trim-time size while debug.log
 *  kept growing unbounded. Direct overwrite is non-atomic (a crash
 *  mid-write could truncate the file), but for a rolling debug log
 *  that tradeoff is acceptable in exchange for the trim actually
 *  working under normal Windows usage. Best-effort; never throws.
 *
 *  Also cleans up any prior `.trimming` temp from the old rename-based
 *  implementation so the user's home dir doesn't accumulate stale
 *  artifacts after the upgrade. */
function maybeTrimLog(): void {
  _writesSinceCheck++;
  if (_writesSinceCheck < TRIM_CHECK_INTERVAL) return;
  _writesSinceCheck = 0;
  try {
    // Cheap size gate: skip the read for files that obviously can't
    // exceed MAX_LOG_LINES yet. 1000 × ~200 B/line ≈ 200KB; 64KB is a
    // safe lower bound. Avoids ~99% of unnecessary reads.
    const size = statSync(LOG).size;
    if (size < TRIM_MIN_BYTES) return;
    const raw = readFileSync(LOG, "utf8");
    // Count newlines without an intermediate array allocation.
    let nl = 0;
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) nl++;
    if (nl <= MAX_LOG_LINES) return;
    // Split on \n; for a file ending in \n the last entry is "" (the
    // trailing empty after the final newline). Keep the last
    // MAX_LOG_LINES entries plus the trailing empty so the join
    // reconstructs a file with the same trailing-newline shape.
    const arr = raw.split("\n");
    const trimmed = arr.slice(arr.length - 1 - MAX_LOG_LINES);
    writeFileSync(LOG, trimmed.join("\n"));
    // Clean up any leftover .trimming temp from the old atomic-rename
    // implementation. Idempotent unlink (no-op if absent).
    try { unlinkSync(LOG + ".trimming"); } catch { /* never existed or already gone */ }
  } catch { /* trim is best-effort; never disrupt the extension */ }
}

// Lifecycle allowlist: these events log even when the verbose firehose is
// off (see the LOGGING POLICY header). Keep it to LOW-VOLUME, PII-FREE
// auth / self-update / activation-health signals — never per-impression or
// per-render events. Exact singletons + family prefixes; the prefixes cover
// the `selfupdate.*` / `boot.cycle.*` forms and FUTURE `auth.*` events
// (the auth client's refresh path is silent today — when it gains logging,
// those events are lifecycle automatically). Exported for the unit test that
// guards this set against drift.
export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "activate", "activate.fatal", "preflight",
  "session.state", "cli.spinnerVerbs",
]);
const LIFECYCLE_PREFIXES = ["selfupdate.", "auth.", "boot.cycle."] as const;
export function isLifecycleEvent(evt: string): boolean {
  return LIFECYCLE_EVENTS.has(evt)
    || LIFECYCLE_PREFIXES.some((p) => evt.startsWith(p));
}

let warned = false;
/** Append one structured line. `data` is JSON-serialized defensively.
 *  Writes when the verbose firehose is enabled OR the event is a lifecycle
 *  event (always-on). */
export function dlog(src: "ext" | "webview", evt: string,
                     data?: Record<string, unknown>,
                     opts?: { level?: "info" | "debug"; corr?: string }): void {
  try {
    if (!debugEnabled() && !isLifecycleEvent(evt)) return;
    mkdirSync(DIR, { recursive: true });
    const level = opts?.level ?? "info";
    const corr = opts?.corr ? opts.corr : "-";
    let payload = "";
    try { payload = data ? " " + JSON.stringify(data) : ""; }
    catch { payload = ' {"_unserializable":true}'; }
    appendFileSync(LOG,
      new Date().toISOString() + " [" + src + "] " + level + " " + corr
        + " " + evt + payload + "\n");
    maybeTrimLog();
  } catch {
    // Logging must never disrupt the extension. Note once to stderr only.
    if (!warned) { warned = true; try { process.stderr.write("vibe-ads: dlog disabled\n"); } catch { /* ignore */ } }
  }
}

/** Persist a raw line the webview relayed (already JSON text). */
export function dlogRaw(line: string): void {
  try {
    if (!debugEnabled()) return;
    mkdirSync(DIR, { recursive: true });
    appendFileSync(LOG,
      new Date().toISOString() + " [webview] info - " + line.slice(0, 8000) + "\n");
    maybeTrimLog();
  } catch { /* never disrupt */ }
}

/** TEST-ONLY: force a trim pass and reset the throttle. Lets the test
 *  suite assert the line-cap behaviour without writing 50× to push past
 *  the throttle. Production callers should never use this. */
export function _forceTrimLogForTest(): void {
  _writesSinceCheck = TRIM_CHECK_INTERVAL;
  maybeTrimLog();
}

export const LOG_PATH = LOG;
