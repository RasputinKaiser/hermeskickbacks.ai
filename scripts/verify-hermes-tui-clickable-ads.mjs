#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = process.env.HOME || homedir();
const tuiRoot = process.env.HERMES_TUI_ROOT || join(home, ".hermes", "hermes-agent", "ui-tui");
const source = join(tuiRoot, "src", "components", "appChrome.tsx");
const built = join(tuiRoot, "dist", "entry.js");
const hermesAgentRoot = join(home, ".hermes", "hermes-agent");
const hermesVenvBin = join(hermesAgentRoot, "venv", "bin", "hermes");
const runTests = !process.argv.includes("--no-tests");

const required = [
  "readKickbacksTickerAd",
  "KickbacksTickerAdText",
  "KICKBACKS_HERMES_TUI_AD_CACHE",
  "click_url",
  "openExternalUrl",
  "stopImmediatePropagation",
  "onOpen(ad.url)",
  "handleKickbacksAdClick",
  "adStartCol",
  "localCol",
];

const failures = [];
const receiptPath = readReceiptPath();
let activeCommandPath = "";
let sourceMtimeMs = null;
let builtMtimeMs = null;

checkActiveHermesCommand();
checkFile("source", source, required);
checkFile("built bundle", built, required);
checkBuiltBundleFresh();

if (runTests) {
  run("TUI status-row link tests", "npm", [
    "test",
    "--",
    "--run",
    "src/__tests__/appChromeStatusRule.test.tsx",
    "src/__tests__/statusRule.test.ts",
    "src/__tests__/statusBarTicker.test.ts",
  ]);
  run("TUI typecheck", "npm", ["run", "typecheck"]);
}

if (failures.length) {
  console.error("Hermes TUI clickable ad verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (receiptPath) {
  writeReceipt(receiptPath);
}

console.log("Hermes TUI clickable ad verification OK");

function checkFile(label, file, needles) {
  if (!existsSync(file)) {
    failures.push(`${label} missing: ${file}`);
    return;
  }

  const text = readFileSync(file, "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) {
      failures.push(`${label} missing ${needle}`);
    }
  }
}

function checkBuiltBundleFresh() {
  if (!existsSync(source) || !existsSync(built)) {
    return;
  }

  sourceMtimeMs = statSync(source).mtimeMs;
  builtMtimeMs = statSync(built).mtimeMs;

  if (builtMtimeMs + 1000 < sourceMtimeMs) {
    failures.push("built TUI bundle is older than appChrome source; run npm run hermes:tui-links");
  }
}

function run(label, cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: tuiRoot, stdio: "inherit" });
  } catch (error) {
    failures.push(`${label} failed with exit ${error.status ?? 1}`);
  }
}

function checkActiveHermesCommand() {
  if (process.env.HERMES_TUI_DIR && process.env.HERMES_TUI_DIR !== tuiRoot) {
    failures.push(`HERMES_TUI_DIR points away from checked TUI root: ${process.env.HERMES_TUI_DIR}`);
  }

  let commandPath = "";

  try {
    commandPath = execFileSync("bash", ["-lc", "command -v hermes"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    failures.push("hermes command not found on PATH");
    return;
  }

  if (!commandPath) {
    failures.push("hermes command not found on PATH");
    return;
  }

  if (!existsSync(commandPath)) {
    failures.push(`hermes command path missing: ${commandPath}`);
    return;
  }

  const shim = readFileSync(commandPath, "utf8");

  if (!shim.includes(hermesVenvBin)) {
    failures.push(`hermes command does not exec checked local install: ${commandPath}`);
  }

  activeCommandPath = commandPath;
}

function readReceiptPath() {
  const index = process.argv.indexOf("--receipt");
  if (index === -1) return "";

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    failures.push("--receipt requires a path");
    return "";
  }

  return resolve(value);
}

function writeReceipt(file) {
  const receipt = {
    schemaVersion: 1,
    surface: "hermes-tui",
    proofLayer: "local-tui-click",
    proofBoundary:
      "local TUI source, built bundle, active hermes command path, and tests only; not backend metric acceptance, earnings movement, or payout settlement",
    generatedAt: new Date().toISOString(),
    tuiRoot: redactHome(tuiRoot),
    source: {
      path: redactHome(source),
      mtimeMs: sourceMtimeMs,
    },
    built: {
      path: redactHome(built),
      mtimeMs: builtMtimeMs,
    },
    activeCommandPath: redactHome(activeCommandPath),
    checks: {
      requiredMarkers: required,
      bundleFresh: true,
      activeCommand: true,
    },
    testsRun: runTests,
  };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`receipt: ${file}`);
}

function redactHome(value) {
  if (!value) return value;
  if (value === home) return "~";
  if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`;
  return value;
}
