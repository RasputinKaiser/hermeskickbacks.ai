import * as vscode from "vscode";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { locateClaudeCode, locateClaudeCodeLog, locateClaudeCliLog } from "./locate";
import { ClaudeCodeAdapter } from "./adapters/claude-code/adapter";
import { CodexAdapter } from "./adapters/codex/adapter";
import { ClaudeCliStatuslineAdapter } from "./adapters/claude-cli/adapter";
import { locateCodexTarget } from "./adapters/registry";
import type { TargetAdapter, PatchParams } from "./adapters/types";
import { StatusBar } from "./statusbar";
import { CapWarning } from "./activation/capWarning";
import { LogTail } from "./activity/logTail";
import { PortfolioClient, fetchPortfolioWithDemoFallback } from "./portfolio/client";
import { MetricsClient, newMetricEventUuid } from "./metrics/client";
import { AuthClient } from "./auth/client";
import { KillSwitchClient, type KillState } from "./killswitch/client";
import { FleetSignals, KILL_STALE_MS } from "./fleetSignals";
import { setupSelfUpdate } from "./activation/selfUpdate";
import { EarningsClient } from "./earnings/client";
import { ConsentClient } from "./consent/client";
import { maybePromptForConsent } from "./consent/prompt";
import { DebugController } from "./debug";
import { setupBootCanary } from "./activation/bootCanary";
import { showInstallReloadNudge, showSignInReloadNudge }
  from "./activation/reloadNudge";
import { notifyIncompatible } from "./activation/incompatNotice";
import { registerDiagnoseCommand } from "./activation/diagnose";
import { setupDesyncDetector, type DesyncState } from "./activation/desyncDetector";
import { shouldReassert } from "./reassert";
import { registerCommands, restoreCodexSafe } from "./activation/commands";
import { setupEarningsRefresh } from "./activation/earningsRefresh";
import { setupWebviewInjection, type WebviewInjectionResult }
  from "./activation/webviewInjection";
import { setupCliSync } from "./activation/cliSync";
import { setupCliTick } from "./activation/cliTick";
import { createActivationContext, type ActivationContext } from "./activation/context";
import { resetServingGate, wireServingGateEnabled, setKillPosture,
  killPosture, canPatch, servingSuspended, servingVerdict }
  from "./servingGate";
import { TestHooks } from "./testHooks";
import { buildLabel, buildVersion } from "./buildinfo";
import { dlog, debugEnabled, codexEnabled, codexDisabled, codexCliEnabled,
         testHooksEnabled } from "./log";
import { codexDiscoveryEnabled } from "./activation/codexFallback";
import { webviewMode } from "./modes";
import { SessionState } from "./sessionState";
import { watchFile as nodeWatchFile, readFileSync, statSync } from "node:fs";
import { reloadSentinelPath, parseSentinel, decideReload } from "./reloadSignal";
import { readConfig, resolveBackendBase, resolveUpdateBase, configPath,
  ensureConfigFile, DEFAULT_POLL_MS } from "./config";
import { errMsg } from "./util/errMsg";

const CFG = readConfig();

const BASE = resolveBackendBase(CFG, process.env.KICKBACKS_BASE || process.env.VIBE_ADS_BASE);

const UPDATE_BASE = resolveUpdateBase(CFG, process.env.KICKBACKS_UPDATE_BASE);

// Client-environment fingerprint sent on every metrics beacon so the backend
// can segment ad traffic by client type (admin Traffic). Transparent and
// minimal: os/arch/os_version/editor only — host/mode/version are derived
// server-side from the surface. Nothing here is hidden or obfuscated.
function clientEnv(): Record<string, unknown> {
  try {
    return {
      os: process.platform,        // win32 / darwin / linux
      arch: process.arch,          // x64 / arm64
      os_version: release(),       // e.g. "10.0.26200"
      editor: vscode.env.appName,  // "Visual Studio Code" / "Cursor" / "Windsurf" / …
    };
  } catch { return {}; }
}

interface Wiring {
  adapter: TargetAdapter;
  codexAdapter?: TargetAdapter | null;
  statusBar: { set: (s: unknown) => void; dispose: () => void };
  capWarning: { show: (c: unknown) => void; hide: () => void; dispose: () => void };
  watchFileFn: typeof import("node:fs").watchFile;
  killed?: boolean;
  /** Test-only: shrink the serving bring-up retry base delay (audit #5). */
  servingRetryBaseMs?: number;
}
let override: Partial<Wiring> | null = null;
export function __wireForTest(w: Partial<Wiring>): void { override = w; }

const watchFileImpl = (): typeof import("node:fs").watchFile =>
  override?.watchFileFn ?? nodeWatchFile;

// ─── Activation Context ───────────────────────────────────────────────
let actx: ActivationContext = createActivationContext();

/** Persisted last-CONFIRMED-kill marker (audit #19). Set when /v1/killswitch
 *  returns 200 killed:true, cleared by a later 200 killed:false. Read at the
 *  top of the NEXT activation so no writer patches before the first live
 *  kill check — without blocking boot on a network round-trip. */
const KILL_CONFIRMED_KEY = "kickbacks.kill.confirmed";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  try {
    actx = createActivationContext();
    resetServingGate();

    const target = locateClaudeCode();
    const adapter: TargetAdapter = override?.adapter ??
      new ClaudeCodeAdapter(target || "/__vibe_ads_no_target__");
    actx.ccAdapter = adapter;

    // Claude preflight, hoisted above Codex resolution: the codex-fallback
    // policy below needs to know whether a compatible Claude Code exists on
    // this machine. Read-only; bootCanary re-runs its own copy later.
    const pf = adapter.preflight();

    // S9: resolve the optional Codex target. Discovery = the explicit opt-in
    // (codexEnabled) OR the claude-incompatible FALLBACK: with no compatible
    // Claude Code here there is nothing of ours to crash (the S9 guard
    // protects dual-install machines, which stay opt-in-only), and without
    // the fallback a Codex-only install is dead weight — red "incompatible"
    // bar, no sign-in, no serving. Explicit opt-out (codexDisabled) beats
    // both. See activation/codexFallback.ts.
    const codexDiscovery = codexDiscoveryEnabled({
      optIn: codexEnabled(), optOut: codexDisabled(),
      claudeCompatible: pf.compatible });
    actx.codexAdapter = override
      ? (override.codexAdapter ?? null)
      : (codexDiscovery
          ? (() => {
              try {
                const ct = locateCodexTarget();
                return ct ? new CodexAdapter(ct) : null;
              } catch { return null; }
            })()
          : null);
    const codexAdapter = actx.codexAdapter;
    // Single guarded Codex preflight, shared by the activation gate, the
    // bootCanary auto-enable widening, and the ccVersion label below.
    const codexPf = (() => {
      try { return codexAdapter?.preflight() ?? null; } catch { return null; }
    })();
    const claudeOk = pf.compatible;
    const codexOk = codexPf?.compatible === true;
    const statusBar = override?.statusBar ?? new StatusBar();
    // Owned by the extension context: disposing with it is the only teardown
    // path that reaches the bar item — deactivate() works off actx and never
    // sees this object, so without this push a disable-without-reload strands
    // the item in the status bar.
    ctx.subscriptions.push(statusBar);

    // Separate red pill that surfaces an hourly/daily earning-cap. Independent
    // of statusBar (own item); same context-owned disposal so a disable-without-
    // reload doesn't strand it.
    const capWarning = override?.capWarning ?? new CapWarning();
    ctx.subscriptions.push(capWarning);

    const session = new SessionState();

    // Manual admin/debug override.
    actx.debugCtl = new DebugController(adapter, ctx,
      (on) => {
        statusBar.set({ kind: "debug", on });
        session.set({ injectionOn: on });
      });
    const debugCtl = actx.debugCtl;
    debugCtl.setCodexAdapter(codexAdapter);

    // Serving gate inputs (wave 2). The user-master-toggle input is the
    // DebugController's persisted intent: ON, or an auto-enable-eligible
    // state (fresh install / sign-out pause). A deliberate "Disable
    // Kickbacks" / Restore command reads disabled here and sticks; the
    // signed-out demo flow (K_ON forced false but K_PRESIGNOUT remembered)
    // stays enabled — the Wave-1 sign-out contract.
    wireServingGateEnabled(
      () => debugCtl.on() || debugCtl.shouldAutoEnableOnSignIn());
    // Boot gate (audit #19): a kill CONFIRMED in a prior session blocks all
    // patch writers from the first instruction — bootCanary and the initial
    // webview apply consult the gate — until a live 200 killed:false clears
    // it. The live check below stays async; boot never blocks on network.
    if (ctx.globalState.get<boolean>(KILL_CONFIRMED_KEY) === true) {
      setKillPosture("confirmed");
      dlog("ext", "kill.persisted", { posture: "confirmed" });
    }

    const dm = () => debugCtl?.openMenu();
    const ec = async () => { try { await debugCtl?.editConfig(); } catch { /* ok */ } };
    ctx.subscriptions.push(
      vscode.commands.registerCommand("kickbacks.debugMenu", dm),
      vscode.commands.registerCommand("vibe-ads.debugMenu", dm),
      vscode.commands.registerCommand("kickbacks.editConfig", ec),
      // Register the diagnose command BEFORE the preflight early-return so it's
      // available precisely when a build reports incompatible.
      // The Codex adapter is located for DIAGNOSIS even when the serving
      // policy keeps discovery off (the dual-install default) — otherwise the
      // report is silent about Codex exactly when a user asks why ads don't
      // show next to it (BUG-001).
      ...registerDiagnoseCommand(adapter, {
        adapter: codexAdapter ?? (() => {
          try {
            const ct = locateCodexTarget();
            return ct ? new CodexAdapter(ct) : null;
          } catch { return null; }
        })(),
        policy: { discoveryEnabled: codexDiscovery, optIn: codexEnabled(),
                  optOut: codexDisabled(), claudeCompatible: pf.compatible },
      }),
    );

    // Test hook injection commands (before preflight early-return).
    if (testHooksEnabled()) {
      ctx.subscriptions.push(
        vscode.commands.registerCommand("kickbacks.test.disableInjection",
          async () => {
            dlog("ext", "testhook.setInjection.fire", { on: false });
            await debugCtl?.setOn(false);
            dlog("ext", "testhook.setInjection.done",
              { on: false, hasDebugCtl: !!debugCtl });
          }),
        vscode.commands.registerCommand("kickbacks.test.enableInjection",
          async () => {
            dlog("ext", "testhook.setInjection.fire", { on: true });
            await debugCtl?.setOn(true);
            dlog("ext", "testhook.setInjection.done",
              { on: true, hasDebugCtl: !!debugCtl });
          }));
      void vscode.commands.executeCommand(
        "setContext", "kickbacks.test.enabled", true);
      dlog("ext", "testhook.injection.enabled", {});
    }

    // ─── Reload sentinel watcher ────────────────────────────────────
    try {
      const trig = reloadSentinelPath();
      const runningVersion = buildVersion();
      const armedAt = Date.now();
      const LAST_HANDLED_KEY = "vibe-ads.reload.lastHandledMtimeMs";
      const RESTART_ATTEMPT_CAP = 3;
      let restartAttempts = 0;
      const persistedHandledMtime = Number(ctx.globalState.get<number>(LAST_HANDLED_KEY) || 0);
      let highestHandledMtime = Math.max(armedAt, persistedHandledMtime);
      watchFileImpl()(trig, { interval: 1000 }, (curr) => {
        let raw: string;
        try { raw = readFileSync(trig, "utf8"); } catch { return; }
        const payload = parseSentinel(raw);
        if (!payload) return;
        if (curr.mtimeMs <= highestHandledMtime) {
          dlog("ext", "reload.skew_ignored", { mtime: curr.mtimeMs,
            highestHandled: highestHandledMtime });
          return;
        }
        const decision = decideReload({
          mtimeMs: curr.mtimeMs, armedAt,
          sentinelVersion: payload.version, runningVersion,
          debug: debugEnabled() });
        dlog("ext", "reload.decision", { decision, mtime: curr.mtimeMs,
          armedAt, sentinelVersion: payload.version, runningVersion,
          attempts: restartAttempts });
        if (decision !== "none") {
          if (restartAttempts >= RESTART_ATTEMPT_CAP) {
            dlog("ext", "reload.cap_hit", { cap: RESTART_ATTEMPT_CAP,
              mtime: curr.mtimeMs });
            return;
          }
          restartAttempts++;
          highestHandledMtime = curr.mtimeMs;
          void ctx.globalState.update(LAST_HANDLED_KEY, curr.mtimeMs);
          vscode.commands.executeCommand("workbench.action.restartExtensionHost");
        }
      });
    } catch { /* watcher is best-effort; never disturb activation */ }

    // ─── Config-file watcher ────────────────────────────────────────
    // Restart only on a genuine CONTENT edit. Baseline is the raw file text
    // (same readFileSync(..., "utf8") readConfig uses), captured lazily on
    // first existence: file CREATION (ensureConfigFile materializing the
    // template on the first "Edit Vibe-Ads config…") just adopts the new
    // content, and a touch / no-op save compares equal — neither may restart
    // the entire extension host out from under the user (audit #35).
    try {
      const cfgPath = configPath();
      const readCfgRaw = (): string | null => {
        try { return readFileSync(cfgPath, "utf8"); } catch { return null; }
      };
      let lastCfgContent = readCfgRaw();   // null while absent
      watchFileImpl()(cfgPath, { interval: 2000 }, (curr) => {
        if (!curr.mtimeMs) return;         // still absent / deleted
        const content = readCfgRaw();
        if (content === null) return;      // raced a delete
        const baseline = lastCfgContent;
        lastCfgContent = content;
        if (baseline === null || content === baseline) return; // create/touch
        dlog("ext", "config.changed", { mtime: curr.mtimeMs });
        vscode.commands.executeCommand("workbench.action.restartExtensionHost");
      });
    } catch { /* never block activation */ }

    // ─── Local-source update ────────────────────────────────────────
    const localVsixPath = CFG.localVsixPath;
    let lastLocalVsixMtime = 0;
    if (localVsixPath) {
      try {
        lastLocalVsixMtime = statSync(localVsixPath).mtimeMs;
      } catch { /* missing initially is fine */ }
    }

    dlog("ext", "activate", { target: !!target, build: buildLabel(),
      debug: debugEnabled() });

    // Boot canary. `anyTargetCompatible` widens the clean-boot auto-enable
    // to Codex-only machines (their K_ON would otherwise never persist).
    const { firstRun } = await setupBootCanary(adapter, debugCtl, ctx,
      claudeOk || codexOk);

    dlog("ext", "preflight",
      { compatible: pf.compatible, version: pf.version, reason: pf.reason,
        codexCompatible: codexOk, codexVersion: codexPf?.version ?? null,
        codexFallback: codexDiscovery && !codexEnabled() });
    if (!claudeOk && !codexOk) {
      statusBar.set({ kind: "incompatible", version: pf.version ?? "unknown" });
      notifyIncompatible(ctx, adapter, pf);
      // Audit #22: this early return used to strand a previously-patched
      // ~/.claude/settings.json forever — no cliSync runs on this path and
      // deactivate()'s CLI restore is null-guarded away. Construct the CLI
      // adapter and run its key-scoped restore once to clean any stale
      // statusLine/spinnerVerbs ad (a no-op when no backup marker exists),
      // then leave it wired so deactivate() can still restore. Full CLI
      // serving is intentionally NOT brought up on this path.
      try {
        actx.cliStatus = new ClaudeCliStatuslineAdapter(
          join(homedir(), ".claude", "settings.json"));
        const r = actx.cliStatus.restore();
        dlog("ext", "cli.strandRestore", { restored: r.restored });
      } catch { /* best-effort; never disturb the early return */ }
      // Codex strand restore (symmetric with audit #22): a previously-served
      // Codex shimmer patch + K_ON=true gets stranded when this machine later
      // turns both-incompatible (e.g. ~/.vibe-ads/codex.disabled set after a
      // codex-only serving run) — deactivate() skips restore while
      // userWantsPatched, and this early return skips all serving teardown.
      // Construct fresh from the locator (codexAdapter is null when discovery
      // is off); restore() is a no-op without a backup marker.
      try {
        const ct = locateCodexTarget();
        if (ct) {
          const r = new CodexAdapter(ct).restore();
          dlog("ext", "codex.strandRestore", { restored: r.restored });
        }
      } catch { /* best-effort; never disturb the early return */ }
      return;
    }

    // First-run install nudge: the patch just landed (bootCanary auto-enable)
    // but the running Claude Code webview predates it — zero earnings until a
    // window reload. Sticky red status bar + modal toast steer the user there.
    // Gated on the patch actually being ON (a failed apply means a reload
    // wouldn't help). The sticky lock clears itself on the reload (fresh
    // activation re-creates the StatusBar).
    if (firstRun && debugCtl.on()) {
      dlog("ext", "installNudge.show", {});
      statusBar.set({ kind: "needs-reload" });
      void showInstallReloadNudge();
    }

    // ─── Auth / clients ─────────────────────────────────────────────
    const auth = new AuthClient(BASE, ctx);
    await auth.loadCached();
    session.set({
      signedIn: !!auth.accessToken(),
      injectionOn: debugCtl.on(),
    });
    debugCtl.setAuth({
      signedIn: () => auth.signedIn(),
      storageInfo: () => auth.storageInfo(),
      signOut: () => auth.signOut(),
    });
    debugCtl.setSessionSnap(() => session.get());
    // Fleet-signal store: receives the killswitch verdict + balances the
    // backend piggybacks on portfolio/metrics responses, so the standalone
    // /v1/killswitch + /v1/earnings pollers below can stand down while the
    // piggybacked data is fresh (fleet-chattiness fix, 2026-06-12).
    const fleetSignals = new FleetSignals();
    const portfolio = new PortfolioClient(BASE, () => auth.accessToken(),
      undefined, fleetSignals);
    const metrics = new MetricsClient(BASE, () => auth.accessToken(),
      () => auth.clientId(), buildVersion(), undefined, clientEnv(),
      fleetSignals);
    const kill = new KillSwitchClient(BASE);
    const { updater } = setupSelfUpdate(
      ctx, UPDATE_BASE, buildVersion(), localVsixPath, lastLocalVsixMtime,
      watchFileImpl(), actx.timers, CFG.updatePollIntervalMs);
    const logTail = new LogTail(locateClaudeCodeLog);
    // Terminal-side activity signal (newest entrypoint:"cli" transcript):
    // feeds the statusbar ad's CLI path and the statusline view-tick loop.
    // A separate LogTail so the overlay/desync watchdog keeps its strict
    // panel-only signal (audit #24).
    const cliTail = new LogTail(locateClaudeCliLog);
    const earningsClient = new EarningsClient(BASE,
      () => auth.accessToken(), fetch, async () => auth.refresh());
    const consentClient = new ConsentClient(BASE, () => auth.accessToken());
    void maybePromptForConsent({
      client: consentClient, ctx, vsc: vscode,
      dlog: (msg) => dlog("ext", "consent", { msg }),
    });
    // Host-version label. Claude-compatible machines report the CC version
    // exactly as before. Codex-only machines report a PREFIXED label
    // ("codex/<ver>") — self-describing in fleet/metrics analytics, and
    // independently kill-targetable (the killswitch version scope is an
    // exact opaque-string match server-side), never colliding with a CC
    // semver key.
    const ccVersion = claudeOk
      ? (pf.version ?? "unknown")
      : `codex/${codexPf?.version ?? "unknown"}`;
    session.set({ ccVersion });

    // ─── Earnings ───────────────────────────────────────────────────
    // The status-bar item is the BALANCE surface, full stop (product
    // decision 2026-06-10): it always shows the earnings/identity states
    // painted by showActive, never ad creative. Ads live on the spinner
    // verb, the in-window overlay, and the TUI statusline (cliTick bills
    // that one) — so no isAdShowing arbiter is wired here anymore.
    const { showActive, scheduleEarningsRefresh } = setupEarningsRefresh(
      // `undefined` keeps isAdShowing's default; capWarning is the new arg.
      auth, earningsClient, session, statusBar, ccVersion, ctx, undefined,
      capWarning, fleetSignals);

    // ─── Portfolio ──────────────────────────────────────────────────
    // Signed in → the real, user-crediting portfolio. Signed out (incl. a
    // present-but-rejected/expired token) → the public DEMO portfolio (real
    // engine ads stamped demo:true). fetchPortfolioWithDemoFallback forces a
    // refresh when a cached-but-dead token yields no ad: re-mint → real ads, or
    // clear → demo. See its docstring for why this keeps every surface aligned.
    // `let`, not `const`: the serving bring-up retry below (audit #5)
    // re-fetches the portfolio when activation found no ad.
    let portfolioResp = await fetchPortfolioWithDemoFallback(
      portfolio, auth, ccVersion);
    let ad = portfolioResp?.ad ?? null;
    let viewThresholdMs = portfolioResp?.viewThresholdMs ?? 3000;
    session.set({ hasAd: !!ad });

    // Lazy portfolio resolve for the debug closure.
    let pendingPortfolioFetch: Promise<typeof ad> | null = null;
    const resolveAdForBilling = async (): Promise<typeof ad> => {
      if (ad) return ad;
      if (!auth.accessToken()) return null;
      if (pendingPortfolioFetch) return pendingPortfolioFetch;
      pendingPortfolioFetch = (async () => {
        try {
          let r = await portfolio.fetchPortfolio(ccVersion);
          if (!r?.ad) {
            const refreshed = await auth.refresh();
            if (refreshed) r = await portfolio.fetchPortfolio(ccVersion);
          }
          if (r?.ad) {
            ad = r.ad;
            session.set({ hasAd: true, signedIn: true, authHealthy: "ok" });
            debugCtl.setPortfolioAd(r.ad.adText, r.ad.clickUrl || "");
            dlog("ext", "portfolio.lazy_resolved", { adId: r.ad.adId });
          }
          return ad;
        } finally {
          pendingPortfolioFetch = null;
        }
      })();
      return pendingPortfolioFetch;
    };

    // Debug-mode metrics sender.
    if (ad) {
      debugCtl.setPortfolioAd(ad.adText, ad.clickUrl || "");
    }
    debugCtl.setMetricsSender((k, p) => {
      void (async () => {
        const a = await resolveAdForBilling();
        if (!a || !auth.accessToken()) return;
        const debugCorr = "debug." + (a.adId || "no-ad").slice(0, 8)
          + "." + Math.random().toString(36).slice(2, 6);
        const eventUuid = p.eventUuid || newMetricEventUuid();
        dlog("ext", "metric.send", { event: k, adId: a.adId,
          surface: p.surface, visibleMs: p.visibleMs, eventUuid },
          { corr: debugCorr });
        metrics.send(k, {
          adId: a.adId,
          campaignId: a.campaignId,
          ccVersion,
          corr: debugCorr,
          sessionToken: a.sessionToken,
          ...p,
          eventUuid,
        });
        if (k === "view_threshold_met" || k === "click"
            || k === "impression_viewable" || k === "error_impression") {
          scheduleEarningsRefresh();
        }
      })();
    });

    // Block-desync diagnostic state.
    const desyncState: DesyncState = { lastApplyAt: 0, lastBlockStartAt: 0 };

    // Kill-switch state. Starts true when a prior session persisted a
    // CONFIRMED kill (boot gate, audit #19); the first checkKill below
    // resolves the live posture.
    let killed = killPosture() !== "clear";

    // Live ref for the e2e test hooks to read the loopback details after
    // they're minted below. Stays null on builds that never patch the webview.
    let lbInfo: { port: number; base: string } | null = null;

    // Test hooks controller.
    const testHooks = new TestHooks(metrics, portfolio, earningsClient, () => ({
      ad,
      signedIn: !!auth.accessToken(),
      killed,
      ccVersion,
      viewThresholdMs,
      loopback: lbInfo,
    }), scheduleEarningsRefresh);

    // Kill hysteresis (wave 2, audit #3/#6/#9/#19):
    //   CONFIRMED (200 killed:true)  → restore every surface, halt all patch
    //     writers via the gate, persist the flag so the NEXT boot is gated.
    //   OFFLINE (error / non-200)    → freeze: no restore, NO new writes
    //     (fail-closed), keep the offline paint, keep checking.
    //   RECOVERY (200 killed:false)  → clear both; writers resume next tick.
    //
    // Verdicts now arrive on TWO paths: the standalone /v1/killswitch poll
    // (the only path allowed to produce the OFFLINE posture — a carrier
    // failure is not evidence about the kill table) and the piggybacked
    // `kill` field off fresh portfolio/metrics 200s (fleetSignals; always
    // confirmed-or-clear, never offline). applyKillVerdict is the single
    // state machine both feed.
    const applyKillVerdict = async (ks: KillState): Promise<void> => {
      killed = ks.killed;
      session.set({ killed });
      if (ks.killed && !ks.confirmed) {
        // Offline-unsure: freeze the current on-disk state. The gate's
        // "offline" posture blocks every writer; nothing is restored, so a
        // wifi blip never churns the user's Claude Code install.
        setKillPosture("offline");
        statusBar.set({ kind: "offline" });
        return;
      }
      if (ks.killed) {
        setKillPosture("confirmed");
        // Best-effort: a Memento rejection on the 30s interval path must not
        // become an unhandled rejection (the restore below still runs).
        try { await ctx.globalState.update(KILL_CONFIRMED_KEY, true); }
        catch { /* best-effort */ }
        adapter.restore();
        restoreCodexSafe(codexAdapter);
        actx.cliStatus?.restore();
        statusBar.set({ kind: "killed" });
        return;
      }
      setKillPosture("clear");
      if (ctx.globalState.get<boolean>(KILL_CONFIRMED_KEY) === true) {
        try { await ctx.globalState.update(KILL_CONFIRMED_KEY, undefined); }
        catch { /* best-effort; retried on the next clear tick */ }
        dlog("ext", "kill.cleared", {});
      }
    };
    const checkKill = async () => {
      if (override?.killed !== undefined) {
        await applyKillVerdict({ killed: !!override.killed,
          confirmed: !!override.killed, offline: false });
        return;
      }
      // Staleness gate: while piggybacked verdicts are fresh the standalone
      // poll stands down (steady-state /v1/killswitch traffic → ~0 on a new
      // backend). On an old backend no piggybacked verdict ever arrives, so
      // this degenerates to exactly the previous 30s poll.
      if (fleetSignals.killFreshWithin(KILL_STALE_MS)) return;
      const ks = await kill.checkOnce(ccVersion, ad?.campaignId || "");
      await applyKillVerdict(ks);
    };
    // Piggybacked verdicts apply the moment they arrive (registration also
    // replays the verdict buffered from the activation portfolio fetch
    // above, which ran before this machinery existed).
    fleetSignals.onKillVerdict((ks) => {
      if (override?.killed !== undefined) return; // test override wins
      void applyKillVerdict(ks);
    });
    await checkKill();

    // ─── Webview injection ──────────────────────────────────────────
    const adRef = { get current() { return ad; }, set current(v) { ad = v; } };
    const killedRef = { get current() { return killed; }, set current(v) { killed = v; } };

    // Lets the ad-apply choke point (adRotation.applyAd) poke the CLI sync the
    // moment an ad changes — sign-in demo→real swap or a rotation — instead of
    // waiting up to 60s for cliSync's own timer. Wired to cliSync.syncNow below
    // (setupCliSync runs after this); until then it's a safe no-op, and the
    // initial ad is covered by setupCliSync's own first sync.
    const cliResync = { run: () => {} };

    // The serving bring-up, re-callable by the retry loop below (audit #5).
    // `killed` is derived from the LIVE kill posture (identical to the
    // checkKill snapshot at the initial call) so a retried attempt after a
    // recovery doesn't replay the boot-time value; portfolioResp /
    // viewThresholdMs are read at call time (a retry refreshes them first).
    let wvResult: WebviewInjectionResult = { lbInfo: null,
      reapplyCodex: null, cycleReassert: null, refreshPortfolioNow: null };
    const bringUpServing = async (): Promise<void> => {
      wvResult = await setupWebviewInjection({
        ctx, actx, adapter, auth, debugCtl, session, portfolio,
        metrics, logTail, testHooks, statusBar, ccVersion,
        killed: killPosture() !== "clear", killedRef, adRef,
        portfolioResp, viewThresholdMs,
        statusBarShowActive: showActive,
        scheduleEarningsRefresh,
        desyncState,
        claudeCompatible: claudeOk,
        onAdApplied: () => cliResync.run(),
      });
      lbInfo = wvResult.lbInfo;
    };
    await bringUpServing();

    if (ad && override?.killed !== true && webviewMode() === "off") {
      adapter.restore();
      restoreCodexSafe(codexAdapter);
      dlog("ext", "webview.forced-off", {});
    }

    // ─── Guaranteed startup reassert (prime) ────────────────────────
    // Prime the invisible loopback connect-src CSP patch on EVERY boot —
    // even with no ad in hand and even signed out — so the surface is ready
    // the instant an ad arrives (no waiting for the 60s reassert tick or a
    // manual reload). Idempotent + invisible: when an ad was present the
    // applyPatch above already inserted this, so prime() is a cheap no-op.
    // The kill-switch, a crash-canary suspension, and an off webviewMode
    // still win (prime directive: a killed / opted-out / crash-suspect
    // install must never have CC files touched).
    if (!killed && !servingSuspended() && webviewMode() === "on") {
      // Claude prime only when the target is genuinely patchable: CSP-priming
      // a present-but-incompatible CC would touch its files for a webview we
      // will never inject (codex-only proceed path).
      if (claudeOk) {
        try { adapter.prime?.(); } catch { /* prime directive */ }
      }
      try { codexAdapter?.prime?.(); } catch { /* prime directive */ }
    }

    // ─── CLI sync ───────────────────────────────────────────────────
    const cliSync = setupCliSync({
      actx, ctx, adapter, auth, metrics, debugCtl, ccVersion,
      adRef, killedRef,
      overrideKilled: override?.killed,
      // Lazy: a retried bring-up (audit #5) replaces wvResult, and the CLI
      // sync's Codex reassert must follow the live value, not the boot one.
      reapplyCodex: () => wvResult.reapplyCodex?.(),
    });
    // Now that the CLI sync exists, point the ad-apply hook at it so every
    // subsequent applyAd re-syncs the CLI surface immediately.
    cliResync.run = cliSync.syncNow;

    // ─── Status bar ─────────────────────────────────────────────────
    // No setupStatusBarAd here (removed 2026-06-10): the VS Code status
    // bar shows the balance at all times and never serves ads. The module
    // stays in src/activation/ unimported (and unit-tested) should the
    // surface ever come back; billing for TUI users runs through the
    // statusline cliTick below, panel users through the overlay.

    // ─── Statusline view ticks (TUI billing) ────────────────────────
    // The dwell loop for the terminal statusline surface — without it a
    // TUI-only user sees ads all day and never earns (cliSync emits
    // impressions only). Gated on a live terminal turn via cliTail.
    setupCliTick({
      cliTail,
      metrics,
      adRef,
      killedRef,
      signedIn: () => !!auth.accessToken(),
      surfaceApplied: () => {
        try { return actx.cliStatus?.preflight().compatible ?? false; }
        catch { return false; }
      },
      ccVersion,
      timers: actx.timers,
    });

    // ─── Periodic timers ────────────────────────────────────────────
    actx.timers.push(setInterval(checkKill, 30_000));
    actx.timers.push(setInterval(() => void showActive(), 30_000));
    actx.timers.push(setInterval(() => void debugCtl?.reassertTick(), 60_000));

    // Tiered desync self-heal. The drift-only reasserts above can't see a
    // "patched file but webview cached the pre-patch module" desync; this
    // watchdog escalates (cyclePatch → webview reload → window-reload toast)
    // ONLY when CC is actively in use (independent transcript-mtime signal)
    // yet our overlay telemetry has gone silent — never when simply idle.
    const hardReassert = (): void => {
      try {
        const c = debugCtl.cyclePatch();        // debug-injection path
        if (!c.ok) wvResult.cycleReassert?.();  // production server-ad path
      } catch { /* prime directive */ }
    };
    setupDesyncDetector(desyncState, actx.timers, {
      ccActivityAgeMs: () => logTail.activityAgeMs(),
      // canPatch() folds in the serving gate (kill posture, master toggle,
      // canary suspension) so the watchdog can never "heal" a gated install.
      healthy: () => canPatch() && shouldReassert({
        haveAd: !!adRef.current,
        killed: killedRef.current,
      }),
      hardReassert,
      // True while the CC panel is in an active tool_use turn (e.g. waiting
      // on a long-running sub-agent). Disruptive escalation (reload, toast)
      // is deferred so we never interrupt an in-progress session. null when
      // the transcript can't be read (treated as not active — safe default).
      ccTurnActive: () => {
        try {
          const a = logTail.current();
          return a !== null && a.done === false ? true : null;
        } catch { return null; }
      },
    });

    // Login trigger: reassert the patch immediately after a successful
    // interactive sign-in (don't wait up to 60s for the next reassert tick).
    auth.setOnSignedIn(() => {
      try {
        void debugCtl.reapplyIfOn();   // debug-injection path
        hardReassert();                // production path (health-gated no-op if no ad)
        // Swap any signed-out DEMO ad for a real, user-crediting one NOW, so
        // post-sign-in impressions bill under the real session token instead
        // of 403-ing on the authed endpoint with a stale demo token. `force`
        // re-applies even when the adId set is unchanged. No-op (null) when the
        // overlay never set up (no ad at activation).
        void wvResult.refreshPortfolioNow?.(true);
        // The live swap above is best-effort; a reload is the path that
        // always works. Tell the user every time they sign in.
        void showSignInReloadNudge();
      } catch { /* prime directive */ }
    });

    // ─── Serving bring-up retry (audit #5) ──────────────────────────
    // Activation while the backend flaps (documented cold-start 502/503),
    // momentarily-empty inventory, or a fail-safed kill probe left the
    // bring-up above returning nulls — and pre-fix NOTHING retried: serving
    // stayed dead until a window reload. Retry with bounded exponential
    // backoff (30s → 60s → 120s …, capped at 5min, indefinitely at the
    // cap). While the serving gate says killed/disabled/suspended/offline
    // the attempt is SKIPPED but the loop stays alive, so a recovery
    // (checkKill clearing the posture) brings serving up in-session
    // without a reload. Ends permanently on success; every pending timer
    // lives in actx.timers so deactivate() disposes it.
    const servingUp = (): boolean => wvResult.refreshPortfolioNow !== null;
    const RETRY_CAP_MS = 5 * 60_000;
    let retryDelayMs = override?.servingRetryBaseMs ?? 30_000;
    const retryActx = actx;   // a newer activation owns its own loop
    const scheduleServingRetry = (): void => {
      actx.timers.push(setTimeout(() => void retryServing(), retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_CAP_MS);
    };
    const retryServing = async (): Promise<void> => {
      try {
        if (actx !== retryActx || servingUp()) return;
        if (servingVerdict() !== "write" || webviewMode() !== "on") {
          dlog("ext", "serving.retry.gated", { verdict: servingVerdict() });
        } else {
          if (!adRef.current) {
            const r = await fetchPortfolioWithDemoFallback(
              portfolio, auth, ccVersion);
            if (r?.ad) {
              portfolioResp = r;
              viewThresholdMs = r.viewThresholdMs;
              ad = r.ad;
              session.set({ hasAd: true });
              debugCtl.setPortfolioAd(r.ad.adText, r.ad.clickUrl || "");
            }
          }
          if (adRef.current && actx === retryActx) {
            await bringUpServing();
            if (servingUp()) {
              dlog("ext", "serving.retry.up", { port: lbInfo?.port });
              cliResync.run();   // fresh ad → CLI surface now, not in ≤60s
              return;            // success — the loop ends permanently
            }
          }
        }
      } catch (e) {
        dlog("ext", "serving.retry.error", { msg: errMsg(e) });
      }
      scheduleServingRetry();
    };
    if (!servingUp() && webviewMode() === "on") {
      dlog("ext", "serving.retry.armed", { inMs: retryDelayMs });
      scheduleServingRetry();
    }

    // ─── Command registration ───────────────────────────────────────
    registerCommands(ctx, adapter, codexAdapter, auth, debugCtl, statusBar,
      session, updater, ccVersion, showActive);

    // ─── E2E test hooks ─────────────────────────────────────────────
    if (testHooksEnabled()) {
      testHooks.registerCommands(ctx);
      ctx.subscriptions.push(
        vscode.commands.registerCommand("kickbacks.test.refreshStatusBar",
          async () => { await showActive(); }));
      void vscode.commands.executeCommand(
        "setContext", "kickbacks.test.enabled", true);
      dlog("ext", "testhook.enabled", {});
    }
  } catch (e) {
    try {
      dlog("ext", "activate.fatal", {
        msg: errMsg(e, 300),
        stack: (e instanceof Error && e.stack ? e.stack : "").split("\n")[0],
      });
    } catch { /* dlog itself must never throw */ }
  }
}

/** Bound a loopback stop so a hung http.Server.close (e.g. an in-flight
 *  webview request) can never exhaust VS Code's deactivation budget
 *  (audit #36). The orphaned close keeps draining in the background. */
const STOP_BUDGET_MS = 2_000;
async function boundedStop(p: Promise<unknown>): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      p.catch(() => { /* ignore */ }),
      new Promise<void>((r) => { t = setTimeout(r, STOP_BUDGET_MS); }),
    ]);
  } finally { if (t) clearTimeout(t); }
}

export async function deactivate(): Promise<void> {
  for (const t of actx.timers) clearInterval(t);
  actx.timers.length = 0;
  try {
    const canaryPath = join(homedir(), ".vibe-ads", "boot.canary");
    if (existsSync(canaryPath)) unlinkSync(canaryPath);
  } catch { /* best-effort */ }
  const userWantsPatched = !!actx.debugCtl?.on();
  // Irreversible user-file restores FIRST (audit #36): a hung loopback close
  // must never leave CC/Codex/settings.json patched after uninstall.
  if (!userWantsPatched) {
    try {
      if (actx.ccAdapter) actx.ccAdapter.restore({ keepCsp: true });
      else {
        const target = locateClaudeCode();
        if (target) new ClaudeCodeAdapter(target).restore({ keepCsp: true });
      }
    } catch { /* ignore */ }
  }
  try { actx.cliStatus?.restore(); } catch { /* ignore */ }
  try { actx.codexCliStatus?.restore(); } catch { /* ignore */ }
  if (!userWantsPatched) {
    try {
      if (actx.codexAdapter) actx.codexAdapter.restore({ keepCsp: true });
      else {
        const ct = locateCodexTarget();
        if (ct) new CodexAdapter(ct).restore({ keepCsp: true });
      }
    } catch { /* ignore */ }
  }
  // Loopback stops LAST, each time-bounded so deactivate always completes.
  if (actx.loopback) { await boundedStop(actx.loopback.stop()); actx.loopback = null; }
  if (actx.debugCtl) { await boundedStop(actx.debugCtl.dispose()); actx.debugCtl = null; }
  actx.cliStatus = null;
  actx.codexCliStatus = null;
  actx.ccAdapter = null;
  actx.codexAdapter = null;
  override = null;
}
