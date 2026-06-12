import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const PLUGIN = join(ROOT, "hermes", "plugins", "kickbacks");
const INSTALLER = join(ROOT, "scripts", "install-hermes-plugin.mjs");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("Hermes Kickbacks integration", () => {
  it("vendors the Hermes plugin source without generated Python caches", () => {
    for (const file of ["plugin.yaml", "__init__.py", "api.py", "tracker.py", "SKILL.md"]) {
      expect(existsSync(join(PLUGIN, file))).toBe(true);
    }

    const vendoredFiles = execFileSync("git", ["ls-files", "hermes/plugins/kickbacks"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim().split(/\r?\n/).filter(Boolean);
    expect(vendoredFiles.some((file) => file.includes("__pycache__"))).toBe(false);
    expect(vendoredFiles.some((file) => file.endsWith(".pyc"))).toBe(false);
  });

  it("keeps Hermes hooks kwargs-compatible and cache fallback wired", () => {
    const init = readFileSync(join(PLUGIN, "__init__.py"), "utf8");
    const tracker = readFileSync(join(PLUGIN, "tracker.py"), "utf8");

    for (const hook of [
      "pre_llm_call",
      "post_llm_call",
      "pre_tool_call",
      "post_tool_call",
      "on_session_start",
      "on_session_end",
    ]) {
      expect(init).toContain(`ctx.register_hook("${hook}"`);
    }

    expect(init).toContain("def on_pre_llm_call(*args, **kwargs)");
    expect(init).toContain("def on_post_llm_call(*args, **kwargs)");
    expect(init).toContain("_cached_ad_fallback()");
    expect(init).toContain("_tracker.set_ad(cached_ad, write_cache=False)");
    expect(tracker).toContain('STOP_GRACE_MS = _env_int("KICKBACKS_STOP_GRACE_MS", 350)');
    expect(tracker).toContain("self._active_spans");
  });

  it("installer status detects an out-of-date Hermes target", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kickbacks-hermes-target-"));
    try {
      const output = execFileSync("node", [
        INSTALLER,
        "--status",
        "--target",
        join(tmp, "kickbacks"),
      ], { encoding: "utf8" });

      expect(output).toContain("current: no");
      expect(output).toContain("target=missing");
      expect(output).toContain("missing:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
