#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const blocked = [
  String.fromCharCode(105, 97, 110),
  String.fromCharCode(105, 97, 110, 122, 118, 105, 114, 98, 117, 108, 105, 115),
  String.fromCharCode(122, 118, 105, 114, 98, 117, 108, 105, 115),
];

const hits = [];

for (const field of ["user.name", "user.email"]) {
  const value = gitConfig(field).toLowerCase();

  if (blocked.some((term) => value.includes(term))) {
    hits.push(`git config ${field}`);
  }
}

for (const term of blocked) {
  const content = spawnSync("git", ["grep", "-n", "-I", "-i", "-F", term, "--", "."], {
    cwd: root,
    encoding: "utf8",
  });
  if (content.status === 0 && content.stdout.trim()) {
    for (const line of content.stdout.trim().split("\n")) {
      hits.push(line);
    }
  } else if (content.status !== 1) {
    process.stderr.write(content.stderr || content.stdout || "git grep failed\n");
    process.exit(content.status || 1);
  }
}

const paths = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
for (const path of paths) {
  const lower = path.toLowerCase();
  if (blocked.some((term) => lower.includes(term))) {
    hits.push(`path:${path}`);
  }
}

if (hits.length) {
  console.error("Upload safety gate failed:");
  for (const hit of hits) console.error(hit);
  process.exit(1);
}

console.log("Upload safety gate OK");

function gitConfig(field) {
  const result = spawnSync("git", ["config", "--get", field], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status === 0) {
    return result.stdout.trim();
  }

  return "";
}
