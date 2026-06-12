// Hook-driven end-to-end: spins up the real activate() pipeline (auth →
// portfolio → ad → loopback → CC adapter → timers → CLI sync), then drives
// `kickbacks.test.*` through the mock vscode dispatcher to exercise the
// whole metric/click/state surface. Hermetic: every network call is captured
// by the fetch stub, every command goes through the real registerCommand /
// executeCommand path on the mock. No real install touched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The global setup mock at test/setup.ts already returns testHooksEnabled:
// true, debugEnabled: false. That gives the test hooks a register-and-fire
// path without polluting the developer's ~/.vibe-ads/debug.log.
import { activate, deactivate, __wireForTest } from "../src/extension";
import { makeContext, secrets, _opened, _shown, _openedDocs, commands }
  from "./mocks/vscode";

const AD = {
  ad_id: "ad-e2e", campaign_id: "camp-e2e", title_text: "Acme - faster CI",
  icon_ref: "icon", click_url: "https://acme.example/lp", banner_enabled: false,
};

const mkAdapter = () => ({
  name: "claude-code" as const,
  preflight: () => ({ ok: true, compatible: true, version: "2.1.143" }),
  version: () => "2.1.143",
  applyPatch: vi.fn(() => ({ ok: true })),
  restore: vi.fn(() => ({ ok: true, restored: true })),
});

/** Fetch stub. Captures every URL+init so individual tests can assert what
 *  the activation chain (or a fired hook) actually sent. Returns:
 *    /v1/portfolio  -> one ad, view_threshold_seconds configurable
 *    /v1/killswitch -> not killed
 *    /v1/earnings   -> $42.00 lifetime / $1.50 today (when signed in)
 *    /v1/metrics    -> 204 — the URL of interest for hook assertions
 *    everything else -> {} 200
 *  Tests mutate `viewThresholdSeconds` and `adOverride` to test forms. */
function stubFetch(opts: { viewThresholdSeconds?: number;
                            adOverride?: typeof AD | null;
                            killed?: boolean } = {}) {
  const calls: { url: string; method: string; body?: unknown;
                 headers: Record<string, string> }[] = [];
  const f = vi.fn(async (input: unknown, init?: { method?: string;
      body?: string; headers?: Record<string, string> }) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? safeJson(init.body) : undefined;
    calls.push({ url, method, body, headers: init?.headers || {} });
    if (url.includes("/v1/auth/extension/poll")) {
      return { ok: true, status: 200, json: async () =>
        ({ access_token: "AT-E2E", refresh_token: "RT-E2E", expires_in: 3600 }) } as Response;
    }
    if (url.includes("/v1/portfolio")) {
      const ad = opts.adOverride === null ? null : (opts.adOverride || AD);
      return { ok: true, status: 200, json: async () => ({
        ttl_seconds: 30,
        view_threshold_seconds: opts.viewThresholdSeconds ?? 15,
        queue_id: "q-1",
        balances: { lifetime_usd: "0.00", today_usd: "0.00", last_updated_ms: 0 },
        ads: ad ? [ad] : [],
      }) } as Response;
    }
    if (url.includes("/v1/killswitch")) {
      return { ok: true, status: 200, json: async () => ({ killed: !!opts.killed }) } as Response;
    }
    if (url.includes("/v1/earnings")) {
      return { ok: true, status: 200, json: async () =>
        ({ lifetime_usd: "42.00", today_usd: "1.50" }) } as Response;
    }
    // /v1/metrics and everything else: 204 OK.
    return { ok: true, status: 204, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", f);
  return { f, calls };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

async function boot(opts: { viewThresholdSeconds?: number;
                             adOverride?: typeof AD | null;
                             killed?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kb-hooksE2E-"));
  const prevHome = process.env.HOME;
  const prevUser = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const adapter = mkAdapter();
  const statusBar = { set: vi.fn(), dispose: vi.fn() };
  __wireForTest({ adapter, statusBar });
  const fetched = stubFetch(opts);
  const ctx = makeContext();
  // Pre-seed an access token via the ext-host secret store. AuthClient's
  // loadCached() reads ctx.secrets first; this gets us "signed in" without
  // driving the broker poll loop and keeps every test ≤ a few hundred ms.
  await ctx.secrets.store("kickbacks.access", "AT-E2E");
  await ctx.secrets.store("kickbacks.refresh", "RT-E2E");
  await ctx.secrets.store("kickbacks.clientId", "CID-E2E");
  await activate(ctx as never);
  return {
    home, adapter, statusBar, ctx, fetched,
    metricsPosts: () => fetched.calls.filter(
      (c) => c.url.endsWith("/v1/metrics")),
    async dispose() {
      await deactivate();
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUser !== undefined) process.env.USERPROFILE = prevUser;
      else delete process.env.USERPROFILE;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

beforeEach(() => {
  secrets.clear();
  commands._handlers.clear();
  commands._executed.length = 0;
  _opened.length = 0;
  _shown.length = 0;
  _openedDocs.length = 0;
  __wireForTest({});
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("hooks E2E — every kickbacks.test.* command drives the real lifecycle",
  () => {

  it("fireImpressionRendered → one POST /v1/metrics with the loaded ad,"
    + " surface=overlay, X-Vibe-Corr header, ring buffer captures the send",
    async () => {
      const env = await boot();
      try {
        const r = await commands.executeCommand(
          "kickbacks.test.fireImpressionRendered") as { ok: boolean; sent: unknown };
        expect(r.ok).toBe(true);
        const metricPosts = env.metricsPosts();
        expect(metricPosts).toHaveLength(1);
        expect(metricPosts[0].body).toMatchObject({
          event_type: "impression_rendered",
          ad_id: "ad-e2e",
          campaign_id: "camp-e2e",
          surface: "overlay",
          claude_code_version: "2.1.143",
        });
        expect(metricPosts[0].headers["X-Vibe-Corr"]).toBeTypeOf("string");
        const snap = await commands.executeCommand(
          "kickbacks.test.getState") as { lastEvents: { event: string }[] };
        expect(snap.lastEvents.some((e) => e.event === "impression_rendered")).toBe(true);
      } finally { await env.dispose(); }
    });

  it("surface coverage: impression_rendered + impression_viewable + click"
    + " across overlay / banner / codex_overlay / statusline ⇒ 12 POSTs",
    async () => {
      const env = await boot();
      try {
        const surfaces = ["overlay", "banner", "codex_overlay", "statusline"] as const;
        for (const surface of surfaces) {
          await commands.executeCommand(
            "kickbacks.test.fireImpressionRendered", { surface });
          await commands.executeCommand(
            "kickbacks.test.fireImpressionViewable", { surface });
          await commands.executeCommand("kickbacks.test.fireClick", { surface });
        }
        const posts = env.metricsPosts();
        expect(posts).toHaveLength(12);
        for (const surface of surfaces) {
          expect(posts.filter((p) =>
            (p.body as { surface?: string }).surface === surface)).toHaveLength(3);
        }
        const events = posts.map((p) => (p.body as { event_type: string }).event_type);
        expect(events.filter((e) => e === "impression_rendered")).toHaveLength(4);
        expect(events.filter((e) => e === "impression_viewable")).toHaveLength(4);
        expect(events.filter((e) => e === "click")).toHaveLength(4);
      } finally { await env.dispose(); }
    });

  it("fireViewThresholdMet without visibleMs uses portfolio's viewThresholdMs"
    + " (server-controlled credit threshold) on the wire", async () => {
      const env = await boot({ viewThresholdSeconds: 20 });
      try {
        const r = await commands.executeCommand(
          "kickbacks.test.fireViewThresholdMet") as { ok: boolean };
        expect(r.ok).toBe(true);
        const post = env.metricsPosts()[0];
        expect(post.body).toMatchObject({
          event_type: "view_threshold_met",
          visible_ms: 20000,
          view_ms: 20000,
          viewable: true,
          view_pct: 100,
        });
      } finally { await env.dispose(); }
    });

  it("test-hook path BYPASSES ImpressionDedupe — two impression_rendered fires"
    + " ⇒ two POSTs (the production loopback path dedupes; hooks pin this"
    + " distinction so a regression in the controller can't sneak in)",
    async () => {
      const env = await boot();
      try {
        await commands.executeCommand("kickbacks.test.fireImpressionRendered");
        await commands.executeCommand("kickbacks.test.fireImpressionRendered");
        expect(env.metricsPosts()).toHaveLength(2);
      } finally { await env.dispose(); }
    });

  it("getState reflects ad loaded + signedIn + loopback active", async () => {
    const env = await boot();
    try {
      const s = await commands.executeCommand(
        "kickbacks.test.getState") as {
          enabled: boolean; signedIn: boolean; killed: boolean;
          ad: { adId: string } | null; loopback: { port: number } | null;
          viewThresholdMs: number };
      expect(s.enabled).toBe(true);
      expect(s.signedIn).toBe(true);
      expect(s.killed).toBe(false);
      expect(s.ad?.adId).toBe("ad-e2e");
      expect(s.viewThresholdMs).toBe(15000);
      // Loopback comes up async during activate; either active OR null is
      // acceptable for the snapshot — what we pin is "no crash, no garbage".
      if (s.loopback) {
        expect(typeof s.loopback.port).toBe("number");
        expect(s.loopback.port).toBeGreaterThan(0);
      }
    } finally { await env.dispose(); }
  });

  it("clearEventLog mid-session wipes the ring; subsequent fires record again",
    async () => {
      const env = await boot();
      try {
        await commands.executeCommand("kickbacks.test.fireImpressionRendered");
        await commands.executeCommand("kickbacks.test.fireImpressionViewable");
        await commands.executeCommand("kickbacks.test.fireClick");
        await commands.executeCommand("kickbacks.test.clearEventLog");
        const before = await commands.executeCommand(
          "kickbacks.test.getState") as { lastEvents: unknown[] };
        expect(before.lastEvents).toHaveLength(0);
        await commands.executeCommand("kickbacks.test.fireViewTick");
        const after = await commands.executeCommand(
          "kickbacks.test.getState") as { lastEvents: { event: string }[] };
        expect(after.lastEvents).toHaveLength(1);
        expect(after.lastEvents[0].event).toBe("view_tick");
      } finally { await env.dispose(); }
    });

  it("refreshPortfolio re-fetches /v1/portfolio and the snapshot reflects it",
    async () => {
      const env = await boot();
      try {
        const before = env.fetched.calls.filter(
          (c) => c.url.includes("/v1/portfolio")).length;
        const got = await commands.executeCommand(
          "kickbacks.test.refreshPortfolio") as { adId: string } | null;
        expect(got?.adId).toBe("ad-e2e");
        const after = env.fetched.calls.filter(
          (c) => c.url.includes("/v1/portfolio")).length;
        expect(after).toBeGreaterThan(before);
      } finally { await env.dispose(); }
    });

  it("refreshEarnings hits /v1/earnings and returns the parsed payload",
    async () => {
      const env = await boot();
      try {
        const e = await commands.executeCommand(
          "kickbacks.test.refreshEarnings") as
          { lifetimeUsd: string; todayUsd: string } | null;
        expect(e).toEqual({ lifetimeUsd: "42.00", todayUsd: "1.50" });
      } finally { await env.dispose(); }
    });

  it("no ad loaded ⇒ fire returns ok:false (gate still on); adId override"
    + " lets a test inject an arbitrary ad for backend-shape verification",
    async () => {
      const env = await boot({ adOverride: null });
      try {
        const noAd = await commands.executeCommand(
          "kickbacks.test.fireImpressionRendered") as { ok: boolean; reason?: string };
        expect(noAd.ok).toBe(false);
        expect(noAd.reason).toMatch(/no ad/i);
        const withOverride = await commands.executeCommand(
          "kickbacks.test.fireImpressionRendered",
          { adId: "ad-X", campaignId: "camp-X" }) as { ok: boolean };
        expect(withOverride.ok).toBe(true);
        const post = env.metricsPosts()[0];
        expect(post.body).toMatchObject({ ad_id: "ad-X", campaign_id: "camp-X" });
      } finally { await env.dispose(); }
    });
});
