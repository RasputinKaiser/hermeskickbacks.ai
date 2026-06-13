#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = process.env.HOME || homedir();
const agentRoot = process.env.HERMES_AGENT_ROOT || join(home, ".hermes", "hermes-agent");

const expected = new Set([
  "cli.py",
  "hermes_cli/commands.py",
  "hermes_cli/kickbacks.py",
  "tests/hermes_cli/test_kickbacks.py",
  "ui-tui/src/__tests__/appChromeStatusRule.test.tsx",
  "ui-tui/src/components/appChrome.tsx",
]);

const failures = [];
const receiptPath = readReceiptPath();
let statusRows = [];
let updateState = { ahead: null, behind: null };
let head = "";

checkAgentRoot();
readGitState();
checkPatchSet();

if (failures.length) {
  console.error("Hermes local patch audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (receiptPath) {
  writeReceipt(receiptPath);
}

console.log("Hermes local patch audit OK");

function checkAgentRoot() {
  if (!existsSync(join(agentRoot, ".git"))) {
    failures.push(`Hermes agent git checkout missing: ${agentRoot}`);
  }
}

function readGitState() {
  if (failures.length) return;

  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: agentRoot,
      encoding: "utf8",
    }).trim();

    const [ahead, behind] = execFileSync("git", ["rev-list", "--left-right", "--count", "HEAD...origin/main"], {
      cwd: agentRoot,
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));

    updateState = {
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
    };

    statusRows = execFileSync("git", ["status", "--porcelain"], {
      cwd: agentRoot,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    failures.push(`could not read Hermes git state: ${error.message}`);
  }
}

function checkPatchSet() {
  if (failures.length) return;

  if (updateState.ahead !== 0 || updateState.behind !== 0) {
    failures.push(`Hermes checkout is not at origin/main: ahead=${updateState.ahead} behind=${updateState.behind}`);
  }

  const actual = new Set(statusRows.map((row) => row.slice(3)));
  const extra = [...actual].filter((file) => !expected.has(file)).sort();
  const missing = [...expected].filter((file) => !actual.has(file)).sort();

  if (extra.length) {
    failures.push(`unexpected local Hermes files: ${extra.join(", ")}`);
  }

  if (missing.length) {
    failures.push(`missing expected local Hermes patch files: ${missing.join(", ")}`);
  }
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
    surface: "hermes-local-install",
    proofLayer: "local-patch-scope",
    proofBoundary:
      "local Hermes git state and expected Kickbacks patch file set only; not backend metric acceptance, earnings movement, or payout settlement",
    generatedAt: new Date().toISOString(),
    agentRoot: redactHome(agentRoot),
    head,
    updateState,
    expectedFiles: [...expected].sort(),
    statusRows,
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
