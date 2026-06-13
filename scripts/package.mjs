import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Packages the extension into TWO files:
//   - kickbacks.vsix          — the canonical, STABLE artifact. The deploy
//     uploads this to the fixed GCS object gs://kickbacks-vsix/kickbacks.vsix,
//     so every running extension's self-update URL stays constant. Never
//     rename this one.
//   - kickbacks-<version>.vsix — a versioned copy with the version baked into
//     the file name, so a built artifact on disk is instantly identifiable.
// The version is the single source of truth in package.json (the deploy bumps
// it before packaging, so this picks up the new number automatically).

/** The versioned artifact name for a given semver. Pure; kept tiny but
 *  separate so the naming convention has one definition. */
export function versionedVsixName(version) {
  return `kickbacks-${version}.vsix`;
}

const STABLE = "kickbacks.vsix";

// scripts/package.mjs -> extension/
const extDir = join(fileURLToPath(import.meta.url), "..", "..");
const stageDir = join(extDir, ".vsce-stage");

function packageManifestForVsce(pkg) {
  const pj = JSON.parse(JSON.stringify(pkg));
  pj.author ??= {
    name: "Andrew McCalip",
    url: "https://github.com/andrewmccalip",
  };
  pj.license ??= "SEE LICENSE IN LICENSE";
  pj.homepage ??= "https://kickbacks.ai";
  pj.bugs ??= { url: "https://github.com/RasputinKaiser/hermeskickbacks.ai/issues" };
  const c = pj.contributes?.commands;
  if (c && !c.some((x) => x.command === "kickbacks.signOut")) {
    const i = c.findIndex((x) => x.command === "kickbacks.signIn");
    if (i >= 0) c.splice(i + 1, 0,
      { command: "kickbacks.signOut", title: "Kickbacks: Sign out" });
  }
  pj.description = "Get paid while you code. Clickable sponsored slots for Claude Code, Codex, and Hermes Agent.";
  return pj;
}

function stagePackage(pkg) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, "package.json"),
    JSON.stringify(packageManifestForVsce(pkg), null, 2) + "\n");

  const readme = existsSync(join(extDir, "dist", "README.md"))
    ? readFileSync(join(extDir, "dist", "README.md"), "utf8")
    : readFileSync(join(extDir, "readme_extension.md"), "utf8");
  writeFileSync(join(stageDir, "README.md"), readme);

  copyFileSync(join(extDir, "LICENSE"), join(stageDir, "LICENSE"));
  cpSync(join(extDir, "dist"), join(stageDir, "dist"), { recursive: true });
  rmSync(join(stageDir, "dist", "README.md"), { force: true });
  cpSync(join(extDir, "media"), join(stageDir, "media"), { recursive: true });
  writeFileSync(join(stageDir, ".vscodeignore"), [
    "node_modules/**",
    "src/**",
    "test/**",
    "scripts/**",
    "*.vsix",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "esbuild.mjs",
    ".vsce-stage/**",
    "",
  ].join("\n"));
}

function run() {
  const pkg = JSON.parse(readFileSync(join(extDir, "package.json"), "utf8"));
  const { version } = pkg;
  const versioned = versionedVsixName(version);

  // Drop any stale versioned vsix from prior builds so the dir always holds
  // exactly the current one (plus the stable kickbacks.vsix). Best-effort.
  for (const f of readdirSync(extDir)) {
    if (/^kickbacks-.*\.vsix$/.test(f) && f !== versioned) {
      try { unlinkSync(join(extDir, f)); } catch { /* ignore */ }
    }
  }

  stagePackage(pkg);

  // shell:true so the vsce .cmd wrapper resolves on Windows (node_modules/.bin
  // is on PATH under `npm run`). Package from a temporary staged root so build
  // metadata never mutates tracked package.json / README.md.
  const r = spawnSync("vsce",
    ["package", "--no-dependencies", "-o", join(extDir, STABLE)],
    { cwd: stageDir, stdio: "inherit", shell: true });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
  rmSync(stageDir, { recursive: true, force: true });

  copyFileSync(join(extDir, STABLE), join(extDir, versioned));
  console.error(`packaged ${STABLE} + ${versioned} (v${version})`);
}

run();
