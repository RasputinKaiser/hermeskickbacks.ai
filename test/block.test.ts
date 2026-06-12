import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

// Load the asset with substitutions applied, exporting its pure fns via the
// module.exports branch (mirrors the ad-01 spike's node-test export).
function load() {
  let src = readFileSync(join(__dirname, "../src/adapters/claude-code/block.asset.js"), "utf8");
  const subs: Record<string,string> = {
    __VIBE_ADS_TIER__: "3", __VIBE_ADS_AD__: JSON.stringify("Acme deploys faster than your CI"),
    __VIBE_ADS_ICON__: JSON.stringify("icon.a"), __VIBE_ADS_PORT__: "5555",
    __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"), __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ck"),
    __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
    __VIBE_ADS_DEBUG__: "false",
    __VIBE_ADS_ICON_URL__: JSON.stringify(""),
    __VIBE_ADS_CLICKURL__: JSON.stringify("https://acme.example/lp?ck"),
    __VIBE_ADS_BANNER_ON__: "true",
    __VIBE_ADS_CORR__: JSON.stringify("ad1.abcd"),
  };
  for (const [k,v] of Object.entries(subs)) src = src.split(k).join(v);
  const mod = { exports: {} as any };
  vm.runInNewContext(src, { module: mod, exports: mod.exports });
  return mod.exports;
}

describe("block.asset", () => {
  it("esc escapes html", () => {
    expect(load().esc('<a "&>')).toBe("&lt;a &quot;&amp;&gt;");
  });
  it("ellipsis cycles 0..5 dots (6 frames)", () => {
    const b = load();
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => b.ellipsis(i)))
      .toEqual(["", " .", " ..", " ...", " ....", " .....", ""]);
  });
  it("buildAdHtml tier<=1 is a bare anchor with theme token color", () => {
    const h = load().buildAdHtml(1, { ad: "Acme", dots: "", elapsed: "" });
    expect(h).toContain("var(--vscode-foreground");
    expect(h).toContain("data-vibe-ads-ad");
    expect(h).not.toContain("flex");
  });
  it("buildAdHtml tier 3: favicon + LEFT-justified underlined ad + dim right",
    () => {
    const h = load().buildAdHtml(3, { ad: "Acme", dots: " .", elapsed: "1.2s" });
    expect(h).toContain("<svg");
    // Left-justified to the favicon (was space-between, which flung the ad
    // text to the far right away from the logo).
    expect(h).toContain("justify-content:flex-start");
    expect(h).not.toContain("space-between");
    // Underlined => reads as the clickable hyperlink it is.
    expect(h).toContain("text-decoration:underline");
    expect(h).not.toContain("text-decoration:none");
    expect(h).toContain("var(--vscode-descriptionForeground");
  });
  it("Continue feature fully removed: done flag is ignored, always renders the ad", () => {
    const b = load();
    // The Continue CTA / done-pill is gone. buildAdHtml never emits a pill;
    // a `done:true` arg is simply ignored — it still renders the ad markup
    // (the render loop, not the builder, decides whether to render at all).
    const h = b.buildAdHtml(3, { ad: "Acme", done: true });
    expect(h).not.toContain("Continue");
    expect(h).not.toContain("data-vibe-ads-continue");
    expect(h).not.toContain("data-vibe-ads-done");
    expect(h).toContain("Acme");                 // still the ad
    expect(h).toContain("data-vibe-ads-ad");     // still the ad-URL click
    // and the asset source itself carries none of the removed plumbing
    const src = readFileSync(
      join(__dirname, "../src/adapters/claude-code/block.asset.js"), "utf8");
    for (const sym of ["injectContinue", "ensureContinuePill",
      "removeContinuePill", "data-vibe-ads-continue", "data-vibe-ads-done"])
      expect(src.includes(sym)).toBe(false);
  });
  describe("looksLikeUsageBanner (usage-banner rewrite prototype)", () => {
    it("matches the real Claude Code weekly-limit banner text", () => {
      const b = load();
      expect(b.looksLikeUsageBanner(
        "You've used 71% of your weekly limit · resets in 4d · View usage")).toBe(true);
    });
    it("matches a 5-hour-window form", () => {
      const b = load();
      expect(b.looksLikeUsageBanner(
        "You've used 92% of your current usage limit · resets in 2h")).toBe(true);
    });
    it("does not match spinner / unrelated chrome text", () => {
      const b = load();
      expect(b.looksLikeUsageBanner("✶ Discombobulating… Read · 1.2s")).toBe(false);
      expect(b.looksLikeUsageBanner("Queue another message…")).toBe(false);
      expect(b.looksLikeUsageBanner("")).toBe(false);
    });
    it("does not match a phrase fragment alone (needs both anchors)", () => {
      const b = load();
      // "resets in" alone (e.g. a docs paragraph) must not trigger a rewrite
      expect(b.looksLikeUsageBanner("Your token resets in the next billing cycle")).toBe(false);
    });
  });

  describe("buildBannerHtml (usage-banner ad render)", () => {
    it("is a clickable, escaped ad anchor carrying the shared click hook", () => {
      const b = load();
      const h = b.buildBannerHtml("Acme & Co <ad>", "https://acme.example/lp?a=1&b=2");
      expect(h).toContain('data-vibe-ads-ad="1"');
      expect(h).toContain('target="_blank"');
      expect(h).toContain('rel="noopener noreferrer"');
      expect(h).toContain("href=\"https://acme.example/lp?a=1&amp;b=2\"");
      expect(h).toContain("Acme &amp; Co &lt;ad&gt;");
      expect(h).toContain("var(--vscode-foreground");
      expect(h).not.toContain("<script");
    });
    it("degrades to # when no url supplied", () => {
      expect(load().buildBannerHtml("Acme", "")).toContain('href="#"');
    });
    it("rejects non-http(s) clickUrl schemes (no javascript: sink)", () => {
      const b = load();
      expect(b.buildBannerHtml("Acme", "javascript:alert(1)")).toContain('href="#"');
      expect(b.buildBannerHtml("Acme", "data:text/html,x")).toContain('href="#"');
      // legitimate https still works
      expect(b.buildBannerHtml("Acme", "https://acme.example/lp")).toContain('href="https://acme.example/lp"');
    });
  });

  it("block carries corr in the click ping and relayed dlog", () => {
    const src = readFileSync(
      join(__dirname, "../src/adapters/claude-code/block.asset.js"), "utf8");
    expect(src).toContain("__VIBE_ADS_CORR__");
    expect(src).toContain("&corr=");
    expect(src).toContain("corr: CORR");
  });

  // Idle DOCK-TO-COMPOSER (replaced freeze-at-pixel). The DOM state machine has
  // no jsdom harness here (the asset runs in a vm with no document), so these
  // are source-level guards mirroring the "Continue removed" test above. The
  // behavioral check is the local VSIX (scroll an idle panel).
  describe("idle dock-to-composer", () => {
    const src = () => readFileSync(
      join(__dirname, "../src/adapters/claude-code/block.asset.js"), "utf8");

    it("docks above the composer at idle instead of freezing at a pixel", () => {
      const s = src();
      expect(s).toContain("function findComposer(");
      expect(s).toContain("function placeDocked(");
      expect(s).toContain("function dockOverlay(");
      // The old freeze-at-pixel entry point is gone (renamed to dockOverlay).
      expect(s).not.toContain("function freezeOverlay(");
      expect(s).not.toContain("freezeOverlay()");
      // Idle branch calls dockOverlay, not the removed freeze.
      expect(s).toContain("dockOverlay();");
    });

    it("has a drop-at-idle fallback when the composer can't be located", () => {
      const s = src();
      // dockOverlay drops if findComposer returns null; the rAF/evaluate
      // re-acquire path drops if the cached composer node disconnects.
      expect(s).toContain("dock_miss_drop");
      expect(s).toContain("dock_lost_drop");
    });

    it("composer locator is read-only and stops the dots via textContent (not innerHTML)", () => {
      const s = src();
      // Read-only locate: querySelector + getBoundingClientRect only.
      const fc = s.slice(s.indexOf("function findComposer("),
        s.indexOf("function placeDocked("));
      expect(fc).toContain("querySelectorAll");
      expect(fc).toContain("getBoundingClientRect");
      // The locator must NEVER mutate CC's composer (prime directive): no
      // assignment to innerHTML / textContent / style inside findComposer.
      expect(fc).not.toContain("innerHTML");
      expect(fc).not.toMatch(/\.textContent\s*=/);
      expect(fc).not.toMatch(/\.style\b/);
      // Stopping the "thinking" animation uses the cached child's textContent,
      // never an innerHTML rewrite (which would detach the click anchor).
      expect(s).toContain('_dotsEl.textContent = ""');
    });

    it("logs the matched composer selector so the locator can be hardened", () => {
      expect(src()).toContain('dlog("composer.found"');
    });
  });

  // View-timer billing integrity (audit 2026-06-09 findings #8/#15/#23).
  // Behavioral coverage lives in cc-viewtimer.test.ts (jsdom); these are
  // cheap source-level reintroduction guards in the style of the dock tests.
  describe("view-timer billing guards (audit #8/#15/#23)", () => {
    const src = () => readFileSync(
      join(__dirname, "../src/adapters/claude-code/block.asset.js"), "utf8");

    it("viewHide ENDS the matching _vt session (the no-op left dropped/" +
       "hidden surfaces emitting error_impression every 5s forever)", () => {
      const s = src();
      expect(s).toContain("function viewEnd(");
      const vh = s.slice(s.indexOf("function viewHide("),
        s.indexOf("function viewMaybeEmit("));
      expect(vh).toContain("viewEnd(adId, surface)");
      expect(vh).not.toContain("No-op");
    });

    it("viewTick clamps suspend/wake poll gaps (no sleep billed, no " +
       "view_tick burst replay on wake)", () => {
      const s = src();
      expect(s).toContain("SUSPEND_GAP_MS");
      const vt = s.slice(s.indexOf("function viewTick("),
        s.indexOf("setInterval(viewTick"));
      expect(vt).toContain("gap > SUSPEND_GAP_MS");
      expect(vt).toContain("sessionStartedAt");
    });
  });
});
