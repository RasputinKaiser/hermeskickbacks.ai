#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const home = process.env.HOME || homedir();
const receiptPath = readArg("--receipt") || join(tmpdir(), `hermes-local-proof-${Date.now()}.json`);
const workDir = join(dirname(receiptPath), `.hermes-local-proof-${process.pid}`);

main();

function main() {
  mkdirSync(workDir, { recursive: true });

  const pluginReceipt = join(workDir, "plugin.json");
  const tuiReceipt = join(workDir, "tui.json");
  const cliReceipt = join(workDir, "cli.json");
  const patchReceipt = join(workDir, "patches.json");

  run("plugin parity receipt", "node", [
    "scripts/install-hermes-plugin.mjs",
    "--status",
    "--receipt",
    pluginReceipt,
  ]);
  run("TUI clickable receipt", "node", [
    "scripts/verify-hermes-tui-clickable-ads.mjs",
    "--receipt",
    tuiReceipt,
  ]);
  run("classic CLI clickable receipt", "node", [
    "scripts/verify-hermes-cli-clickable-ads.mjs",
    "--receipt",
    cliReceipt,
  ]);
  run("local patch scope receipt", "node", [
    "scripts/verify-hermes-local-patches.mjs",
    "--receipt",
    patchReceipt,
  ]);

  const receipt = {
    schemaVersion: 1,
    surface: "hermes-local-proof",
    proofLayer: "local-hermes-plugin-tui-cli-clickable",
    proofBoundary:
      "local plugin file parity, TUI clickable-link checks, classic CLI clickable-link checks, and local patch-scope audit only; not backend metric acceptance, earnings movement, or payout settlement",
    generatedAt: new Date().toISOString(),
    repo: readRepoState(),
    receipts: {
      plugin: redactReceipt(readJson(pluginReceipt)),
      tui: redactReceipt(readJson(tuiReceipt)),
      classicCli: redactReceipt(readJson(cliReceipt)),
      patches: redactReceipt(readJson(patchReceipt)),
    },
  };

  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`Hermes local proof receipt: ${receiptPath}`);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return resolve(value);
}

function run(label, cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
  } catch (error) {
    throw new Error(`${label} failed with exit ${error.status ?? 1}`);
  }
}

function readJson(file) {
  if (!existsSync(file)) {
    throw new Error(`missing receipt: ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function readRepoState() {
  const head = git(["rev-parse", "HEAD"]);
  const originHead = git(["rev-parse", "origin/main"], true);
  const upstreamState = git(["rev-list", "--left-right", "--count", "origin/main...upstream/main"], true);
  const [ahead, behind] = upstreamState
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));

  return {
    head,
    originHead,
    matchesOrigin: Boolean(originHead) && head === originHead,
    originAheadOfUpstream: Number.isFinite(ahead) ? ahead : null,
    originBehindUpstream: Number.isFinite(behind) ? behind : null,
  };
}

function git(args, optional = false) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", optional ? "ignore" : "pipe"],
    }).trim();
  } catch (error) {
    if (optional) return "";
    throw error;
  }
}

function redactReceipt(value) {
  if (Array.isArray(value)) return value.map(redactReceipt);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactReceipt(nested)]),
    );
  }
  if (typeof value !== "string") return value;
  return redactHome(value);
}

function redactHome(value) {
  if (value === home) return "~";
  if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}
