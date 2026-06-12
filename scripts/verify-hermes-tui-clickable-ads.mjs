#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.HOME || homedir();
const tuiRoot = process.env.HERMES_TUI_ROOT || join(home, ".hermes", "hermes-agent", "ui-tui");
const source = join(tuiRoot, "src", "components", "appChrome.tsx");
const built = join(tuiRoot, "dist", "entry.js");
const runTests = !process.argv.includes("--no-tests");

const required = [
  "readKickbacksTickerAd",
  "KickbacksTickerAdText",
  "KICKBACKS_HERMES_TUI_AD_CACHE",
  "click_url",
];

const failures = [];

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
