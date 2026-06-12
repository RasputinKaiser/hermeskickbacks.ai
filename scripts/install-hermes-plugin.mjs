#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(String(args.source || join(repoRoot, "hermes", "plugins", "kickbacks")));
const target = resolve(String(args.target || join(homedir(), ".hermes", "plugins", "kickbacks")));
const dryRun = Boolean(args["dry-run"] || args.dryRun);
const statusOnly = Boolean(args.status);
const checkOnly = Boolean(args.check);
const force = Boolean(args.force);
const backup = !Boolean(args["no-backup"] || args.noBackup);
const json = Boolean(args.json);
const receiptPath = args.receipt ? resolve(String(args.receipt)) : "";

main();

function main() {
  assertSource(source);

  const comparison = compareTrees(source, target);
  const sourceVersion = readPluginVersion(source);
  const targetVersion = existsSync(target) ? readPluginVersion(target) : "missing";

  if (statusOnly || checkOnly) {
    printStatus({ comparison, sourceVersion, targetVersion });
    if (checkOnly && !comparison.current) process.exitCode = 1;
    return;
  }

  if (comparison.current && !force) {
    printStatus({ comparison, sourceVersion, targetVersion });
    console.log("Hermes Kickbacks plugin is already current.");
    return;
  }

  if (dryRun) {
    printStatus({ comparison, sourceVersion, targetVersion });
    console.log(`dry-run: would install ${source} -> ${target}`);
    if (existsSync(target) && backup) {
      console.log(`dry-run: would create backup beside ${target}`);
    }
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (backup) {
      const backupPath = `${target}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      cpSync(target, backupPath, {
        recursive: true,
        dereference: false,
        filter: shouldCopyPath,
      });
      console.log(`backup: ${backupPath}`);
    }
    rmSync(target, { recursive: true, force: true });
  }

  cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: shouldCopyPath,
  });

  const installed = compareTrees(source, target);
  printStatus({ comparison: installed, sourceVersion, targetVersion: readPluginVersion(target) });
  if (!installed.current) {
    console.error("install failed: target does not match source");
    process.exitCode = 1;
    return;
  }
  console.log("Hermes Kickbacks plugin installed.");
  console.log("Restart active Hermes sessions so they import the updated plugin.");
}

function parseArgs(tokens) {
  const parsed = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) continue;
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue || true;
      continue;
    }
    const next = tokens[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[rawKey] = next;
      i += 1;
    } else {
      parsed[rawKey] = true;
    }
  }
  return parsed;
}

function assertSource(dir) {
  const required = ["plugin.yaml", "__init__.py", "api.py", "tracker.py", "SKILL.md"];
  for (const file of required) {
    if (!existsSync(join(dir, file))) {
      console.error(`missing Hermes plugin source file: ${join(dir, file)}`);
      process.exit(1);
    }
  }
}

function compareTrees(leftRoot, rightRoot) {
  const left = fingerprintTree(leftRoot);
  const right = existsSync(rightRoot) ? fingerprintTree(rightRoot) : new Map();
  const missing = [];
  const changed = [];
  const extra = [];
  for (const [file, hash] of left.entries()) {
    if (!right.has(file)) {
      missing.push(file);
    } else if (right.get(file) !== hash) {
      changed.push(file);
    }
  }
  for (const file of right.keys()) {
    if (!left.has(file)) extra.push(file);
  }
  return {
    current: missing.length === 0 && changed.length === 0 && extra.length === 0,
    sourceFiles: left.size,
    targetFiles: right.size,
    missing,
    changed,
    extra,
  };
}

function fingerprintTree(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  for (const file of walk(root)) {
    const rel = relative(root, file).split("\\").join("/");
    out.set(rel, createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  return out;
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (!shouldCopyPath(full)) continue;
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function shouldCopyPath(filePath) {
  const base = filePath.split(/[\\/]/).pop() || "";
  if (base === "__pycache__") return false;
  if (base.endsWith(".pyc")) return false;
  try {
    const st = statSync(filePath);
    if (st.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return true;
}

function readPluginVersion(root) {
  try {
    const raw = readFileSync(join(root, "plugin.yaml"), "utf8");
    const match = raw.match(/^version:\s*["']?([^"'\n]+)["']?/m);
    return match ? match[1].trim() : "unknown";
  } catch {
    return "missing";
  }
}

function printStatus({ comparison, sourceVersion, targetVersion }) {
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: statusOnly ? "status" : checkOnly ? "check" : dryRun ? "dry-run" : "install",
    source,
    target,
    sourceVersion,
    targetVersion,
    current: comparison.current,
    sourceFiles: comparison.sourceFiles,
    targetFiles: comparison.targetFiles,
    missing: comparison.missing,
    changed: comparison.changed,
    extra: comparison.extra,
  };
  writeReceipt(payload);
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`source: ${source}`);
  console.log(`target: ${target}`);
  console.log(`version: source=${sourceVersion} target=${targetVersion}`);
  console.log(`current: ${comparison.current ? "yes" : "no"}`);
  console.log(`files: source=${comparison.sourceFiles} target=${comparison.targetFiles}`);
  if (comparison.missing.length) console.log(`missing: ${comparison.missing.join(", ")}`);
  if (comparison.changed.length) console.log(`changed: ${comparison.changed.join(", ")}`);
  if (comparison.extra.length) console.log(`extra: ${comparison.extra.join(", ")}`);
  if (receiptPath) console.log(`receipt: ${receiptPath}`);
}

function writeReceipt(payload) {
  if (!receiptPath) return;
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
