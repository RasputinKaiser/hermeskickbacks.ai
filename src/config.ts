// User-editable extension config at ~/.vibe-ads/config.json.
//
// Shape (all fields optional):
//   {
//     "backendBaseUrl":      "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app",
//     "localVsixPath":       "C:/path/to/kickbacks.vsix", // mtime-watched
//     "updatePollIntervalMs": 90000,                   // remote poll cadence
//     "debugMode":           false                     // enable dlog writes (debug logging)
//   }
//
// Reads are best-effort: a missing/malformed file resolves to the defaults so
// activation can never be broken by config. Writes go through ensureFile()
// which materialises the file with the current effective defaults the first
// time the user opens the editor.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isLoopbackBase } from "./util/loopback";

export interface VibeAdsConfig {
  backendBaseUrl: string;
  /** Base URL for the self-update manifest poll. When set, the UpdateClient
   *  uses this instead of backendBaseUrl — so self-update can point at the
   *  public site while auth/metrics stay on the local backend. Empty string
   *  falls through to the env var, then to the compiled-in default. */
  updateBaseUrl: string;
  localVsixPath: string;
  updatePollIntervalMs: number;
  /** When true, the extension behaves as if `VIBE_ADS_DEBUG=1` or the
   *  `~/.vibe-ads/debug.enabled` sentinel were present: dlog writes events.
   *  False (or unset) = off. */
  debugMode: boolean;
}

export const DEFAULT_POLL_MS = 90_000;

export function configDir(): string {
  return join(homedir(), ".vibe-ads");
}
export function configPath(): string {
  return join(configDir(), "config.json");
}

function defaults(): VibeAdsConfig {
  return { backendBaseUrl: "", updateBaseUrl: "", localVsixPath: "",
           updatePollIntervalMs: DEFAULT_POLL_MS, debugMode: false };
}

export function readConfig(): VibeAdsConfig {
  const out = defaults();
  try {
    const raw = readFileSync(configPath(), "utf8");
    const j = JSON.parse(raw) as Partial<VibeAdsConfig>;
    if (typeof j.backendBaseUrl === "string") out.backendBaseUrl = j.backendBaseUrl.trim();
    if (typeof j.updateBaseUrl === "string") out.updateBaseUrl = j.updateBaseUrl.trim();
    if (typeof j.localVsixPath === "string") out.localVsixPath = j.localVsixPath.trim();
    if (typeof j.updatePollIntervalMs === "number" && j.updatePollIntervalMs >= 10_000) {
      out.updatePollIntervalMs = j.updatePollIntervalMs;
    }
    if (typeof j.debugMode === "boolean") out.debugMode = j.debugMode;
  } catch { /* absent or malformed -> defaults */ }
  return out;
}

/** Materialise the config file with current defaults if it doesn't exist.
 *  Used by the debug "Edit config" entry so the user always opens a real,
 *  documented file. Returns the absolute path either way. */
export function ensureConfigFile(): string {
  const p = configPath();
  if (!existsSync(p)) {
    try { mkdirSync(configDir(), { recursive: true }); } catch { /* ok */ }
    const tmpl = {
      // Backend / manifest base URL. Empty string -> use VIBE_ADS_BASE env
      // var, else fall back to production Cloud Run. Used by auth, metrics,
      // killswitch, earnings, consent.
      backendBaseUrl: "",
      // Self-update manifest base URL. Empty -> KICKBACKS_UPDATE_BASE env var
      // -> public site default. Separates the update path (can be public)
      // from the API path (may still be localhost during migration).
      updateBaseUrl: "",
      // Optional local-source update: an absolute path to a .vsix file. When
      // set, the extension watches its mtime and installs whenever it changes
      // — useful for dev rigs without a manifest server. Empty -> disabled.
      localVsixPath: "",
      // Remote-manifest poll cadence in ms. Clamped to >= 10s.
      updatePollIntervalMs: DEFAULT_POLL_MS,
      // Debug mode. Equivalent to setting `VIBE_ADS_DEBUG=1` or touching
      // ~/.vibe-ads/debug.enabled: enables dlog writes. Off in prod.
      debugMode: false,
    };
    try { writeFileSync(p, JSON.stringify(tmpl, null, 2) + "\n", "utf8"); }
    catch { /* best-effort */ }
  }
  return p;
}

export const DEFAULT_BACKEND_BASE = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app";
export const DEFAULT_UPDATE_BASE = "https://kickbacks-public-gmdaqm2c7q-uw.a.run.app";

function canonicalBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function isOfficialBase(raw: string, official: string): boolean {
  try {
    return new URL(canonicalBase(raw)).origin === new URL(official).origin;
  } catch {
    return false;
  }
}

function allowedServiceBase(raw: string, official: string): string | null {
  const value = canonicalBase(raw);
  if (!value) return null;
  if (isOfficialBase(value, official) || isLoopbackBase(value)) return value;
  return null;
}

/** Resolve the effective backend base URL: config file > env > default.
 *  Production clients stay on Kickbacks.ai's official service. Loopback is
 *  retained for local development; unrelated third-party API hosts are ignored. */
export function resolveBackendBase(cfg: VibeAdsConfig, env: string | undefined): string {
  if (cfg.backendBaseUrl) return allowedServiceBase(cfg.backendBaseUrl, DEFAULT_BACKEND_BASE) ?? DEFAULT_BACKEND_BASE;
  if (env) return allowedServiceBase(env, DEFAULT_BACKEND_BASE) ?? DEFAULT_BACKEND_BASE;
  return DEFAULT_BACKEND_BASE;
}

/** Resolve the self-update manifest base URL: config > env > public site.
 *  Separated from the API base so self-update works over the public internet
 *  while auth/metrics stay on the official API or loopback during local dev. */
export function resolveUpdateBase(cfg: VibeAdsConfig, env: string | undefined): string {
  if (cfg.updateBaseUrl) return allowedServiceBase(cfg.updateBaseUrl, DEFAULT_UPDATE_BASE) ?? DEFAULT_UPDATE_BASE;
  if (env) return allowedServiceBase(env, DEFAULT_UPDATE_BASE) ?? DEFAULT_UPDATE_BASE;
  return DEFAULT_UPDATE_BASE;
}
