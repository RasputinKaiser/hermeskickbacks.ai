// Shared Kickbacks brand renderer. The mark is the "K$" wordmark in Montserrat
// 800 (white) on a vertical green gradient rounded square — a real typeface, so
// it's rasterized with headless Chromium (Playwright) rather than drawn
// procedurally. Montserrat is pulled from Google Fonts at render time.
//
// Used by gen-icon.mjs (marketplace icon) and gen-logos.mjs (full asset set).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// --- brand constants ---
export const GRAD_TOP = "#2aa44f";
export const GRAD_BOT = "#147a34";
export const GREEN = "#188a45";      // solid brand green (mono mark)
export const INK = "#17181a";
export const RADIUS_RATIO = 0.22;    // rounded-square corner radius
export const FONT_RATIO = 0.47;      // K$ cap size vs icon size
export const FONT_STACK =
  "Montserrat, -apple-system, 'Segoe UI', Arial, sans-serif";

// Resolve playwright-core from one of the repo's e2e installs (no dedicated dep
// in extension/). Portable: paths are relative to the repo root.
export function loadChromium() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const candidates = [
    "site/e2e",
    "test-stack/site-e2e",
    "test-stack/stripe-e2e",
    "test-stack",
  ].map((p) => join(root, p, "package.json"));
  for (const c of candidates) {
    try {
      return createRequire(c)("playwright-core").chromium;
    } catch {}
  }
  try {
    return createRequire(import.meta.url)("playwright-core").chromium;
  } catch {}
  throw new Error(
    "playwright-core not found. Install it (npm i -D playwright-core && npx playwright install chromium) " +
    "or run from a checkout that has site/e2e installed."
  );
}

const FONT_LINKS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&display=swap" rel="stylesheet">`;

function iconHTML(size) {
  const r = Math.round(size * RADIUS_RATIO);
  const fs = Math.round(size * FONT_RATIO);
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_LINKS}
<style>html,body{margin:0;background:transparent}
#mark{width:${size}px;height:${size}px;border-radius:${r}px;
background:linear-gradient(180deg,${GRAD_TOP} 0%,${GRAD_BOT} 100%);
display:flex;align-items:center;justify-content:center;color:#fff;
font-family:${FONT_STACK};font-weight:800;font-size:${fs}px;line-height:1;
letter-spacing:-.02em}</style></head>
<body><div id="mark">K$</div></body></html>`;
}

function lockupHTML(height) {
  const badge = Math.round(height * 0.92);
  const r = Math.round(badge * RADIUS_RATIO);
  const bfs = Math.round(badge * FONT_RATIO);
  const wfs = Math.round(height * 0.62);
  return `<!doctype html><html><head><meta charset="utf-8">${FONT_LINKS}
<style>html,body{margin:0;background:transparent}
#lk{display:inline-flex;align-items:center;gap:${Math.round(height * 0.22)}px;padding:${Math.round(height * 0.12)}px}
#b{width:${badge}px;height:${badge}px;border-radius:${r}px;flex:none;
background:linear-gradient(180deg,${GRAD_TOP} 0%,${GRAD_BOT} 100%);
display:flex;align-items:center;justify-content:center;color:#fff;
font-family:${FONT_STACK};font-weight:800;font-size:${bfs}px;line-height:1;letter-spacing:-.02em}
#w{font-family:${FONT_STACK};font-weight:700;font-size:${wfs}px;color:${INK};
letter-spacing:-.02em;line-height:1}</style></head>
<body><div id="lk"><div id="b">K$</div><div id="w">Kickbacks.ai</div></div></body></html>`;
}

// Render a batch of icon sizes + an optional lockup with ONE browser launch.
// Returns { icons: Map<size, Buffer>, lockup?: Buffer }.
export async function renderAssets({ sizes = [], lockupHeight = 0 } = {}) {
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: true });
  const icons = new Map();
  let lockup;
  try {
    for (const size of sizes) {
      const page = await browser.newPage({
        viewport: { width: size + 40, height: size + 40 },
        deviceScaleFactor: 1,
      });
      await page.setContent(iconHTML(size), { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const buf = await page.locator("#mark").screenshot({ omitBackground: true });
      icons.set(size, buf);
      await page.close();
    }
    if (lockupHeight) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: lockupHeight * 3 },
        deviceScaleFactor: 2,
      });
      await page.setContent(lockupHTML(lockupHeight), { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      lockup = await page.locator("#lk").screenshot({ omitBackground: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return { icons, lockup };
}

// --- SVG forms (font-based; render true Montserrat where the font is
// available, fall back to a bold sans elsewhere) ---
export function markSVG({ box = true, fill = "#fff" } = {}) {
  const rect = box
    ? `\n  <defs><linearGradient id="kb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${GRAD_TOP}"/><stop offset="1" stop-color="${GRAD_BOT}"/></linearGradient></defs>\n  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#kb)"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Kickbacks.ai">${rect}
  <text x="64" y="64" text-anchor="middle" dominant-baseline="central" font-family="${FONT_STACK}" font-weight="800" font-size="62" letter-spacing="-2" fill="${fill}">K$</text>
</svg>`;
}

// --- ICO encoder (packs PNG buffers) ---
export function toICO(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}
