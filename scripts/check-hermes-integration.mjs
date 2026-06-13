#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "hermes", "plugins", "kickbacks");
const installer = join(root, "scripts", "install-hermes-plugin.mjs");
const expectedOrigin = "https://github.com/RasputinKaiser/hermeskickbacks.ai.git";
const expectedUpstream = "https://github.com/andrewmccalip/kickbacks.ai";

const failures = [];

check("fork remotes keep Hermes upload boundary", () => {
  assert(gitOutput(["remote", "get-url", "origin"]) === expectedOrigin, "origin should target Hermes fork");
  assert(gitOutput(["remote", "get-url", "--push", "origin"]) === expectedOrigin, "origin push should target Hermes fork");
  assert(gitOutput(["remote", "get-url", "upstream"]) === expectedUpstream, "upstream should fetch source repo");
  assert(gitOutput(["remote", "get-url", "--push", "upstream"]) === "DISABLED", "upstream push should stay disabled");
});

check("required Hermes plugin files exist", () => {
  for (const file of ["plugin.yaml", "__init__.py", "api.py", "tracker.py", "SKILL.md"]) {
    assert(existsSync(join(plugin, file)), `missing ${file}`);
  }
});

check("Hermes upload and TUI link scripts are wired", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert(pkg.scripts?.["upload:safety"] === "node scripts/check-upload-safety.mjs", "missing upload safety script");
  assert(pkg.scripts?.["upload:audit-public"] === "node scripts/audit-public-upload.mjs", "missing public upload audit script");
  assert(
    pkg.scripts?.["hermes:tui-links"] === "node scripts/patch-hermes-tui-clickable-ads.mjs",
    "missing Hermes TUI link patch script",
  );
  assert(
    pkg.scripts?.["hermes:tui-verify"] === "node scripts/verify-hermes-tui-clickable-ads.mjs",
    "missing Hermes TUI link verify script",
  );
  assert(
    pkg.scripts?.["hermes:cli-links"] === "node scripts/patch-hermes-cli-clickable-ads.mjs",
    "missing Hermes classic CLI link patch script",
  );
  assert(
    pkg.scripts?.["hermes:cli-verify"] === "node scripts/verify-hermes-cli-clickable-ads.mjs",
    "missing Hermes classic CLI link verify script",
  );
  assert(
    pkg.scripts?.["hermes:patch-audit"] === "node scripts/verify-hermes-local-patches.mjs",
    "missing Hermes local patch audit script",
  );
  assert(
    pkg.scripts?.["hermes:proof"] === "node scripts/write-hermes-local-proof.mjs",
    "missing Hermes local proof receipt script",
  );
  assert(
    pkg.scripts?.["hermes:update-safe"] === "node scripts/update-hermes-with-kickbacks.mjs",
    "missing safe Hermes update script",
  );
  assert(
    pkg.scripts?.["hermes:verify"]?.startsWith("npm run upload:safety &&"),
    "Hermes verify should run upload safety first",
  );
  assert(
    pkg.scripts?.["hermes:full-verify"] === "npm run hermes:verify && npm run hermes:tui-verify && npm run hermes:cli-verify && npm run hermes:patch-audit && npm run upload:audit-public",
    "missing full Hermes verification script",
  );
  assert(existsSync(join(root, "scripts", "check-upload-safety.mjs")), "missing upload safety checker");
  assert(existsSync(join(root, "scripts", "audit-public-upload.mjs")), "missing public upload auditor");
  assert(existsSync(join(root, "scripts", "patch-hermes-tui-clickable-ads.mjs")), "missing TUI link patcher");
  assert(existsSync(join(root, "scripts", "verify-hermes-tui-clickable-ads.mjs")), "missing TUI link verifier");
  assert(existsSync(join(root, "scripts", "patch-hermes-cli-clickable-ads.mjs")), "missing classic CLI link patcher");
  assert(existsSync(join(root, "scripts", "verify-hermes-cli-clickable-ads.mjs")), "missing classic CLI link verifier");
  assert(existsSync(join(root, "scripts", "verify-hermes-local-patches.mjs")), "missing local patch auditor");
  assert(existsSync(join(root, "scripts", "write-hermes-local-proof.mjs")), "missing local proof receipt writer");
  assert(existsSync(join(root, "scripts", "update-hermes-with-kickbacks.mjs")), "missing safe Hermes updater");

  const safeUpdater = readFileSync(join(root, "scripts", "update-hermes-with-kickbacks.mjs"), "utf8");
  assert(
    safeUpdater.includes("\"hermes:install\"") &&
      safeUpdater.indexOf("\"hermes:install\"") < safeUpdater.indexOf("\"hermes:tui-links\"") &&
      safeUpdater.indexOf("\"hermes:tui-links\"") < safeUpdater.indexOf("\"hermes:cli-links\""),
    "safe Hermes updater must refresh plugin parity before TUI and classic CLI patches",
  );

  const localProof = readFileSync(join(root, "scripts", "write-hermes-local-proof.mjs"), "utf8");
  assert(
    localProof.includes("\"hermes:test\"") && localProof.includes("pluginTests"),
    "Hermes local proof receipt must include plugin behavior tests",
  );
});

check("generated Python caches are not vendored", () => {
  const files = trackedPluginFiles();
  assert(!files.some((file) => file.includes("__pycache__")), "tracked __pycache__");
  assert(!files.some((file) => file.endsWith(".pyc")), "tracked .pyc");
});

check("hooks are kwargs-compatible and cache fallback is wired", () => {
  const init = readFileSync(join(plugin, "__init__.py"), "utf8");
  const tracker = readFileSync(join(plugin, "tracker.py"), "utf8");
  for (const hook of [
    "pre_llm_call",
    "post_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "on_session_start",
    "on_session_end",
  ]) {
    assert(init.includes(`ctx.register_hook("${hook}"`), `missing hook ${hook}`);
  }
  assert(init.includes("def on_pre_llm_call(*args, **kwargs)"), "pre LLM hook is not kwargs-compatible");
  assert(init.includes("def on_post_llm_call(*args, **kwargs)"), "post LLM hook is not kwargs-compatible");
  assert(init.includes("_cached_ad_fallback()"), "missing cache fallback");
  assert(
    init.includes("_tracker.set_ad(cached_ad, write_cache=False)"),
    "cache fallback should not rewrite cache timestamps",
  );
  assert(
    tracker.includes('STOP_GRACE_MS = _env_int("KICKBACKS_STOP_GRACE_MS", 350)'),
    "missing 350ms stop grace default",
  );
  assert(tracker.includes("self._active_spans"), "missing active span tracking");
});

check("installer status detects missing target", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kickbacks-hermes-target-"));
  try {
    const output = execFileSync("node", [
      installer,
      "--status",
      "--target",
      join(tmp, "kickbacks"),
    ], { encoding: "utf8" });
    assert(output.includes("current: no"), "status did not report stale target");
    assert(output.includes("target=missing"), "status did not report missing version");
    assert(output.includes("missing:"), "status did not list missing files");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("installer rejects unsafe source and target layouts", () => {
  const same = runInstallerExpectFailure([
    "--status",
    "--source",
    plugin,
    "--target",
    plugin,
  ]);
  assert(same.stderr.includes("source and target must be different"), "same source/target should fail");

  const nestedTarget = runInstallerExpectFailure([
    "--status",
    "--source",
    plugin,
    "--target",
    join(plugin, "nested", "kickbacks"),
  ]);
  assert(nestedTarget.stderr.includes("target must not be inside"), "target inside source should fail");

  const tmp = mkdtempSync(join(tmpdir(), "kickbacks-hermes-unsafe-"));
  try {
    const badName = runInstallerExpectFailure([
      "--status",
      "--target",
      join(tmp, "not-kickbacks"),
    ]);
    assert(badName.stderr.includes("target must be a kickbacks directory"), "bad target name should fail");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("installer status detects extra target files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kickbacks-hermes-extra-"));
  try {
    const target = join(tmp, "kickbacks");
    execFileSync("node", [
      installer,
      "--target",
      target,
      "--no-backup",
    ], { encoding: "utf8" });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale.py"), "# stale local file\n", "utf8");

    const output = execFileSync("node", [
      installer,
      "--status",
      "--target",
      target,
    ], { encoding: "utf8" });

    assert(output.includes("current: no"), "status did not reject extra target file");
    assert(output.includes("extra: stale.py"), "status did not list extra target file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("installer JSON status is machine-readable", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kickbacks-hermes-json-"));
  try {
    const output = execFileSync("node", [
      installer,
      "--status",
      "--json",
      "--target",
      join(tmp, "kickbacks"),
    ], { encoding: "utf8" });
    const status = JSON.parse(output);
    assert(status.schemaVersion === 1, "JSON status should expose schemaVersion");
    assert(status.surface === "hermes", "JSON status should expose Hermes surface");
    assert(status.proofLayer === "hermes-plugin-file-parity", "JSON status should expose proof layer");
    assert(status.proofBoundary.includes("not runtime visibility"), "JSON status should expose proof boundary");
    assert(status.current === false, "JSON status should expose current=false");
    assert(Array.isArray(status.missing), "JSON status should expose missing array");
    assert(Array.isArray(status.extra), "JSON status should expose extra array");
    assert(typeof status.sourceDigest === "string", "JSON status should expose sourceDigest");
    assert(typeof status.targetDigest === "string", "JSON status should expose targetDigest");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("installer can write a machine-readable receipt", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kickbacks-hermes-receipt-"));
  try {
    const receiptPath = join(tmp, "receipt.json");
    const output = execFileSync("node", [
      installer,
      "--status",
      "--receipt",
      receiptPath,
      "--target",
      join(tmp, "kickbacks"),
    ], { encoding: "utf8" });
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert(output.includes(`receipt: ${receiptPath}`), "status output should name receipt path");
    assert(receipt.schemaVersion === 1, "receipt should include schemaVersion");
    assert(receipt.surface === "hermes", "receipt should include Hermes surface");
    assert(receipt.proofLayer === "hermes-plugin-file-parity", "receipt should include proof layer");
    assert(receipt.proofBoundary.includes("not runtime visibility"), "receipt should include proof boundary");
    assert(receipt.mode === "status", "receipt should include status mode");
    assert(receipt.current === false, "receipt should expose current=false");
    assert(Array.isArray(receipt.missing), "receipt should expose missing array");
    assert(typeof receipt.sourceDigest === "string", "receipt should include sourceDigest");
    assert(typeof receipt.targetDigest === "string", "receipt should include targetDigest");
    assert(receipt.generatedAt, "receipt should include generatedAt");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

check("installer digests prove exact file parity and drift", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kickbacks-hermes-digest-"));
  try {
    const target = join(tmp, "kickbacks");
    execFileSync("node", [
      installer,
      "--target",
      target,
      "--no-backup",
    ], { encoding: "utf8" });

    const current = JSON.parse(execFileSync("node", [
      installer,
      "--status",
      "--json",
      "--target",
      target,
    ], { encoding: "utf8" }));
    assert(current.current === true, "fresh install should be current");
    assert(current.sourceDigest === current.targetDigest, "fresh install digests should match");

    writeFileSync(join(target, "plugin.yaml"), "name: stale\nversion: stale\n", "utf8");
    const stale = JSON.parse(execFileSync("node", [
      installer,
      "--status",
      "--json",
      "--target",
      target,
    ], { encoding: "utf8" }));
    assert(stale.current === false, "changed target should not be current");
    assert(stale.sourceDigest !== stale.targetDigest, "changed target digest should differ");
    assert(stale.changed.includes("plugin.yaml"), "changed target should name plugin.yaml");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("Hermes integration contract OK");

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runInstallerExpectFailure(args) {
  const result = spawnSync("node", [installer, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) {
    throw new Error(`installer unexpectedly passed: ${args.join(" ")}`);
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function trackedPluginFiles() {
  try {
    return execFileSync("git", ["ls-files", "hermes/plugins/kickbacks"], {
      cwd: root,
      encoding: "utf8",
    }).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return walk(plugin).filter((file) => !file.includes("__pycache__") && !file.endsWith(".pyc"));
  }
}
