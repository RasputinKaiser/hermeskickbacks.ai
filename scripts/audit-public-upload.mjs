#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const owner = "RasputinKaiser";
const repo = "hermeskickbacks.ai";
const remoteRef = process.argv.find((arg) => arg.startsWith("--ref="))?.slice("--ref=".length) || "origin/main";
const skipFetch = process.argv.includes("--no-fetch");
const skipGithub = process.argv.includes("--no-github");
const skipUpstream = process.argv.includes("--no-upstream");
const localMode = process.argv.includes("--local") || remoteRef !== "origin/main";
const blocked = [
  String.fromCharCode(105, 97, 110),
  String.fromCharCode(105, 97, 110, 122, 118, 105, 114, 98, 117, 108, 105, 115),
  String.fromCharCode(122, 118, 105, 114, 98, 117, 108, 105, 115),
];

const failures = [];
let auditRoot = root;
let tmpRoot = "";

if (!localMode) {
  auditRoot = freshAuditRepo();
}

if (localMode && !skipFetch && remoteRef === "origin/main") {
  run(["fetch", "origin", "main"], "fetch origin/main");
}

if (localMode && !skipFetch && !skipUpstream && remoteRef === "origin/main") {
  run(["fetch", "upstream", "main"], "fetch upstream/main");
}

if (!skipUpstream && remoteRef === "origin/main") {
  checkUpstreamCurrent();
}

for (const term of blocked) {
  scanGit(["grep", "-n", "-I", "-i", "-F", term, remoteRef, "--", "."], `remote content: ${term}`);
}

const paths = git(["ls-tree", "-r", "--name-only", remoteRef], "list remote paths")
  .split("\n")
  .filter(Boolean);
for (const path of paths) {
  const lower = path.toLowerCase();
  if (blocked.some((term) => lower.includes(term))) {
    failures.push(`remote path hit: ${path}`);
  }
}

const refs = git(
  ["for-each-ref", "--format=%(refname) %(objectname) %(authorname) %(authoremail) %(subject)", "refs/remotes/origin", "refs/tags"],
  "list refs"
);
for (const line of refs.split("\n").filter(Boolean)) {
  const lower = line.toLowerCase();
  if (blocked.some((term) => lower.includes(term))) {
    failures.push(`remote ref/meta hit: ${line}`);
  }
}

const repoMeta = gh(["repo", "view", `${owner}/${repo}`, "--json", "name,owner,description,homepageUrl,defaultBranchRef,url,visibility"]);
if (repoMeta) {
  const lower = repoMeta.toLowerCase();
  if (blocked.some((term) => lower.includes(term))) {
    failures.push("GitHub repository metadata contains a blocked term");
  }
}

if (!skipGithub) {
  for (const term of blocked) {
    const results = gh([
      "search",
      "code",
      `${term} repo:${owner}/${repo}`,
      "--json",
      "path,repository,textMatches",
      "--limit",
      "20",
    ]);
    if (results && results.trim() !== "[]") {
      failures.push(`GitHub code search hit for blocked term: ${results.trim()}`);
    }
  }
}

if (failures.length) {
  console.error("Public upload audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  cleanup();
  process.exit(1);
}

console.log("Public upload audit OK");
cleanup();

function freshAuditRepo() {
  tmpRoot = mkdtempSync(join(tmpdir(), "kickbacks-public-audit-"));
  const dir = join(tmpRoot, "repo");
  const originUrl = `https://github.com/${owner}/${repo}.git`;
  const upstreamUrl = "https://github.com/andrewmccalip/kickbacks.ai";
  try {
    execFileSync("git", ["clone", "--no-checkout", originUrl, dir], { stdio: "pipe" });
    execFileSync("git", ["remote", "add", "upstream", upstreamUrl], { cwd: dir, stdio: "pipe" });
    if (!skipUpstream) {
      execFileSync("git", ["fetch", "upstream", "main"], { cwd: dir, stdio: "pipe" });
    }
  } catch (error) {
    failures.push(`fresh remote clone failed: ${error.stderr?.toString() || error.message}`);
  }
  return dir;
}

function cleanup() {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
}

function git(args, label) {
  const result = spawnSync("git", args, { cwd: auditRoot, encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${label} failed: ${result.stderr || result.stdout}`.trim());
    return "";
  }
  return result.stdout || "";
}

function run(args, label) {
  try {
    execFileSync("git", args, { cwd: auditRoot, stdio: "pipe" });
  } catch (error) {
    failures.push(`${label} failed: ${error.stderr?.toString() || error.message}`);
  }
}

function scanGit(args, label) {
  const result = spawnSync("git", args, { cwd: auditRoot, encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    failures.push(`${label}\n${result.stdout.trim()}`);
  } else if (result.status !== 1) {
    failures.push(`${label} scan failed: ${result.stderr || result.stdout}`.trim());
  }
}

function checkUpstreamCurrent() {
  const counts = git(["rev-list", "--left-right", "--count", "origin/main...upstream/main"], "compare upstream");
  const [aheadText, missingText] = counts.trim().split(/\s+/);
  const missing = Number.parseInt(missingText || "0", 10);

  if (Number.isFinite(missing) && missing > 0) {
    failures.push(`origin/main is missing ${missing} upstream commit(s)`);
  }
}

function gh(args) {
  const result = spawnSync("gh", args, { cwd: auditRoot, encoding: "utf8" });
  if (result.status === 0) {
    return result.stdout || "";
  }
  if (result.error?.code === "ENOENT") {
    return "";
  }
  failures.push(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout}`.trim());
  return "";
}
