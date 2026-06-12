import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

function load(iconUrl: string = "") {
  let src = readFileSync(
    join(__dirname, "../src/adapters/claude-code/block.asset.js"), "utf8");
  const subs: Record<string, string> = {
    __VIBE_ADS_TIER__: "3",
    __VIBE_ADS_AD__: JSON.stringify("Acme deploys faster than your CI"),
    __VIBE_ADS_ICON__: JSON.stringify("icon.a"),
    __VIBE_ADS_ICON_URL__: JSON.stringify(iconUrl),
    __VIBE_ADS_PORT__: "5555",
    __VIBE_ADS_LBTOKEN__: JSON.stringify("lt"),
    __VIBE_ADS_CLICKTOKEN__: JSON.stringify("ck"),
    __VIBE_ADS_BASE__: JSON.stringify("http://127.0.0.1:5555/vibe-ads/lt"),
    __VIBE_ADS_DEBUG__: "false",
    __VIBE_ADS_CLICKURL__: JSON.stringify("https://acme.example/lp"),
    __VIBE_ADS_BANNER_ON__: "true",
    __VIBE_ADS_CORR__: JSON.stringify("ad1.test"),
    __VIBE_ADS_VIEW_THRESHOLD_MS__: "15000",
  };
  for (const [k, v] of Object.entries(subs)) src = src.split(k).join(v);
  const mod = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(src, { module: mod, exports: mod.exports });
  return mod.exports;
}

describe("block.asset icon rendering (ICON_URL feature)", () => {
  it("no icon_url: buildAdHtml tier 3 renders the fallback K SVG badge", () => {
    const b = load("");
    const h = (b.buildAdHtml as Function)(3, {
      ad: "Acme", dots: "", elapsed: "1.2s",
    });
    expect(h).toContain("<svg");
    expect(h).toContain("fill=\"#188a45\"");
    expect(h).toContain(">K</text>");
    expect(h).not.toContain("<img");
  });

  it("with icon_url: buildAdHtml tier 3 renders an <img> tag", () => {
    const url = "https://storage.googleapis.com/bucket/ad-icons/ad-1.png";
    const b = load(url);
    const h = (b.buildAdHtml as Function)(3, {
      ad: "Acme", dots: "", elapsed: "1.2s",
    });
    expect(h).toContain("<img");
    expect(h).toContain(`src="${url}"`);
    expect(h).toContain('width="13"');
    expect(h).toContain('height="13"');
    expect(h).toContain("object-fit:contain");
    expect(h).not.toContain("<svg");
    // data-va-icon marks the img for the capture-phase error→K-badge fallback.
    expect(h).toContain('data-va-icon="1"');
    // Inline onerror= would be CSP-blocked by CC's script-src; must not appear.
    expect(h).not.toContain("onerror");
  });

  it("data: URI icon (the CSP-safe path) renders an <img> with that src", () => {
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const b = load(url);
    const h = (b.buildAdHtml as Function)(3, {
      ad: "Acme", dots: "", elapsed: "1.2s",
    });
    expect(h).toContain("<img");
    expect(h).toContain(`src="${url}"`);
    expect(h).toContain('data-va-icon="1"');
    expect(h).not.toContain("<svg");
  });

  it("icon_url with special chars is HTML-escaped in img src", () => {
    const url = "https://storage.googleapis.com/bucket/ad-icons/test&icon.png";
    const b = load(url);
    const h = (b.buildAdHtml as Function)(3, {
      ad: "Acme", dots: "", elapsed: "1.2s",
    });
    expect(h).toContain("test&amp;icon.png");
    expect(h).not.toContain("test&icon.png");
  });

  it("tier 1 (bare anchor) — icon_url does NOT render <img>", () => {
    const url = "https://storage.googleapis.com/bucket/ad-icons/ad-1.png";
    const b = load(url);
    const h = (b.buildAdHtml as Function)(1, { ad: "Acme", dots: "" });
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<svg");
  });

  it("buildBannerHtml renders icon when icon_url present", () => {
    const url = "https://storage.googleapis.com/bucket/ad-icons/banner.png";
    const b = load(url);
    const h = (b.buildBannerHtml as Function)(
      "Acme banner text", "https://acme.example/lp");
    expect(h).toContain("<img");
    expect(h).toContain(`src="${url}"`);
    expect(h).toContain('data-vibe-ads-ad="1"');
  });

  it("buildBannerHtml falls back to V badge when no icon_url", () => {
    const b = load("");
    const h = (b.buildBannerHtml as Function)(
      "Acme banner text", "https://acme.example/lp");
    expect(h).toContain('data-vibe-ads-ad="1"');
    // Banner may or may not include the favicon — depends on implementation.
    // The key rule: no <img> tag when no icon_url.
    expect(h).not.toContain("<img");
  });
});
