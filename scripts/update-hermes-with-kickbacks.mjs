#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME || homedir();
const agentRoot = process.env.HERMES_AGENT_ROOT || join(home, ".hermes", "hermes-agent");
const backupRoot = process.env.HERMES_KICKBACKS_BACKUP_DIR || join(root, "..", "..", ".codex", "hermes-update-backups");
const skipUpdate = process.argv.includes("--skip-update");
const skipVerify = process.argv.includes("--skip-verify");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const backupDir = join(backupRoot, stamp);

try {
  main();
} catch (error) {
  console.error("Hermes update/reapply failed:");
  console.error(`- ${error.message}`);
  process.exit(1);
}

function main() {
  requireGitCheckout();
  mkdirSync(backupDir, { recursive: true });
  writeText("pre-status.txt", git(["status", "--short", "--branch"]));
  writeText("pre-head.txt", git(["rev-parse", "HEAD"]));
  writeText("pre-update-state.txt", git(["rev-list", "--left-right", "--count", "HEAD...origin/main"], { optional: true }));
  writeText("local.patch", git(["diff"], { optional: true }));
  backupUntrackedFiles();

  const stashName = `kickbacks-before-hermes-update-${stamp}`;
  const hadLocalChanges = git(["status", "--porcelain"]).trim().length > 0;

  if (hadLocalChanges) {
    run("stash Hermes local patches", "git", ["stash", "push", "-u", "-m", stashName], { cwd: agentRoot });
  }

  if (!skipUpdate) {
    run("Hermes update", "hermes", ["update"], { cwd: root });
  }

  run("reapply Hermes TUI links", "npm", ["run", "hermes:tui-links"], { cwd: root });
  run("reapply Hermes classic CLI links", "npm", ["run", "hermes:cli-links"], { cwd: root });

  if (!skipVerify) {
    run("verify Hermes integration", "npm", ["run", "hermes:full-verify"], { cwd: root });
  }

  writeText("post-status.txt", git(["status", "--short", "--branch"]));
  writeText("post-head.txt", git(["rev-parse", "HEAD"]));
  writeText("post-update-state.txt", git(["rev-list", "--left-right", "--count", "HEAD...origin/main"], { optional: true }));

  if (hadLocalChanges) {
    writeText("stash-kept.txt", `stash left in place: ${stashName}\n`);
  }

  console.log(`Hermes update/reapply OK; backup: ${backupDir}`);
}

function requireGitCheckout() {
  if (!existsSync(join(agentRoot, ".git"))) {
    console.error(`Hermes agent git checkout missing: ${agentRoot}`);
    process.exit(1);
  }
}

function run(label, cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || agentRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? 1}`);
  }
}

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: agentRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.optional) {
      return `${error.message}\n`;
    }
    throw error;
  }
}

function writeText(name, text) {
  writeFileSync(join(backupDir, name), text, "utf8");
}

function backupUntrackedFiles() {
  const output = git(["ls-files", "-o", "--exclude-standard"], { optional: true });
  writeText("untracked-files.txt", output);

  const files = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const file of files) {
    const source = join(agentRoot, file);
    const target = join(backupDir, "untracked", file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}
