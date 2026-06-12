#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

checkActiveHermesCommand();
checkFile("source", source, required);
checkFile("built bundle", built, required);

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
}
