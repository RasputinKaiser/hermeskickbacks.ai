#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = process.env.HOME || homedir();
const agentRoot = process.env.HERMES_AGENT_ROOT || join(home, ".hermes", "hermes-agent");
const cliFile = join(agentRoot, "cli.py");
const kickbacksFile = join(agentRoot, "hermes_cli", "kickbacks.py");
const testFile = join(agentRoot, "tests", "hermes_cli", "test_kickbacks.py");
const hermesVenvBin = join(agentRoot, "venv", "bin", "hermes");
const pythonBin = join(agentRoot, "venv", "bin", "python");
const runTests = !process.argv.includes("--no-tests");

const required = {
  [kickbacksFile]: [
    "def current_ad_link(",
    "def _safe_http_url(value: Any) -> str:",
    "urlparse(url)",
    "parsed.scheme not in {\"http\", \"https\"}",
  ],
  [cliFile]: [
    "self._kickbacks_ad_url",
    "current_ad_link(",
    "def _render_spinner_fragments(self):",
    "\\x1b]8;;{url}\\x1b\\\\{ad}\\x1b]8;;\\x1b\\\\",
    "return cli_ref._render_spinner_fragments()",
  ],
  [testFile]: [
    "test_current_ad_link_returns_text_and_safe_url",
    "test_current_ad_link_rejects_non_http_url",
    "test_cli_spinner_fragments_wrap_ad_with_osc8_link",
  ],
};

const failures = [];
const receiptPath = readReceiptPath();
let activeCommandPath = "";
let updateState = { available: null, ahead: null, behind: null };

checkActiveHermesCommand();
checkMarkers();
checkHermesUpdateState();

if (runTests) {
  run("Hermes classic CLI Kickbacks tests", pythonBin, [
    "-m",
    "pytest",
    testFile,
  ]);
}

if (failures.length) {
  console.error("Hermes classic CLI clickable ad verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (receiptPath) {
  writeReceipt(receiptPath);
}

const updateSuffix =
  updateState.behind && updateState.behind > 0
    ? `; Hermes update available (${updateState.behind} commits behind origin/main)`
    : "";
console.log(`Hermes classic CLI clickable ad verification OK${updateSuffix}`);

function checkMarkers() {
  for (const [file, needles] of Object.entries(required)) {
    if (!existsSync(file)) {
      failures.push(`missing file: ${file}`);
      continue;
    }

    const text = readFileSync(file, "utf8");
    for (const needle of needles) {
      if (!text.includes(needle)) {
        failures.push(`${file} missing ${needle}`);
      }
    }
  }
}

function run(label, cmd, args) {
  if (!existsSync(cmd)) {
    failures.push(`${label} command missing: ${cmd}`);
    return;
  }

  try {
    execFileSync(cmd, args, { cwd: agentRoot, stdio: "inherit" });
  } catch (error) {
    failures.push(`${label} failed with exit ${error.status ?? 1}`);
  }
}

function checkActiveHermesCommand() {
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

function checkHermesUpdateState() {
  try {
    execFileSync("git", ["fetch", "origin", "main"], {
      cwd: agentRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const [ahead, behind] = execFileSync("git", ["rev-list", "--left-right", "--count", "HEAD...origin/main"], {
      cwd: agentRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));

    updateState = {
      available: Number.isFinite(behind) ? behind > 0 : null,
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
    };
  } catch {
    updateState = { available: null, ahead: null, behind: null };
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
    surface: "hermes-classic-cli",
    proofLayer: "local-cli-click",
    proofBoundary:
      "local classic CLI source, active hermes command path, and focused tests only; not backend metric acceptance, earnings movement, or payout settlement",
    generatedAt: new Date().toISOString(),
    agentRoot: redactHome(agentRoot),
    activeCommandPath: redactHome(activeCommandPath),
    files: {
      cli: redactHome(cliFile),
      kickbacks: redactHome(kickbacksFile),
      tests: redactHome(testFile),
    },
    checks: {
      requiredMarkers: Object.fromEntries(
        Object.entries(required).map(([filePath, markers]) => [redactHome(filePath), markers]),
      ),
      activeCommand: true,
      updateState,
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
