// Generates the full Kickbacks logo asset set in extension/media/logos/.
// The mark is the "K$" wordmark (Montserrat 800, white) on a vertical green
// gradient rounded square. Raster sizes are produced with headless Chromium
// (real typeface — see _brand.mjs); SVG forms are font-based.
// Run: `node extension/scripts/gen-logos.mjs`.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderAssets, markSVG, toICO, GREEN } from "./_brand.mjs";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "logos");
mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 180, 192, 256, 512];
const { icons, lockup } = await renderAssets({ sizes, lockupHeight: 120 });

const bySize = new Map();
for (const size of sizes) {
  const png = icons.get(size);
  const name = `kickbacks-${size}.png`;
  writeFileSync(join(outDir, name), png);
  bySize.set(size, png);
  console.log(`  ${name} (${png.length} bytes)`);
}

// favicon.ico (16, 32, 48)
const ico = toICO([16, 32, 48].map((size) => ({ size, png: bySize.get(size) })));
writeFileSync(join(outDir, "favicon.ico"), ico);
console.log(`  favicon.ico (${ico.length} bytes, 3 sizes)`);

// Derived web/social names
writeFileSync(join(outDir, "favicon-32.png"), bySize.get(32));
writeFileSync(join(outDir, "apple-touch-icon.png"), bySize.get(180));
writeFileSync(join(outDir, "og-logo.png"), bySize.get(512));
writeFileSync(join(outDir, "icon-192.png"), bySize.get(192));
writeFileSync(join(outDir, "icon-512.png"), bySize.get(512));
console.log("  favicon-32 / apple-touch-icon / og-logo / icon-192 / icon-512");

// Horizontal lockup (mark + "Kickbacks.ai") for README / docs
writeFileSync(join(outDir, "kickbacks-lockup.png"), lockup);
console.log(`  kickbacks-lockup.png (${lockup.length} bytes)`);

// SVG forms
writeFileSync(join(outDir, "kickbacks.svg"), markSVG({ box: true, fill: "#fff" }));
writeFileSync(join(outDir, "favicon.svg"), markSVG({ box: true, fill: "#fff" }));
writeFileSync(join(outDir, "kickbacks-white.svg"), markSVG({ box: false, fill: "#fff" }));
writeFileSync(join(outDir, "kickbacks-green.svg"), markSVG({ box: false, fill: GREEN }));
console.log("  kickbacks.svg / favicon.svg / kickbacks-white.svg / kickbacks-green.svg");

console.log(`\nDone! All assets in: ${outDir}`);
