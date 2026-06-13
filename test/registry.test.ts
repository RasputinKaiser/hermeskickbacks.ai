import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/adapters/registry";

function ccTarget(): string {
  const d = mkdtempSync(join(tmpdir(), "cc-"));
  const p = join(d, "index.js");
  writeFileSync(p, 'var a=["Discombobulating","x"];', "utf8");
  return p;
}
function codexTarget(): string {
  const r = mkdtempSync(join(tmpdir(), "cx-"));
  const dir = join(r, "openai.chatgpt-26.0.0", "webview", "assets");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "thinking-shimmer-x.js");
  writeFileSync(p,
    "function v(e){};export{v as n,g as t};var q=(0,d.jsx);defaultMessage:`Thinking`",
    "utf8");
  return p;
}

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe("registry.discover", () => {
  it("neither present -> empty", () => {
    process.env.KICKBACKS_CC_TARGET = "/nope";
    process.env.VIBE_ADS_CC_TARGET = "/nope";
    process.env.KICKBACKS_CODEX_TARGET = "/nope";
    process.env.VIBE_ADS_CODEX_TARGET = "/nope";
    expect(discover().length).toBe(0);
  });
  it("CC only", () => {
    process.env.KICKBACKS_CC_TARGET = ccTarget();
    process.env.VIBE_ADS_CC_TARGET = ccTarget();
    process.env.KICKBACKS_CODEX_TARGET = "/nope";
    process.env.VIBE_ADS_CODEX_TARGET = "/nope";
    expect(discover().map((x) => x.id)).toEqual(["claude-code"]);
  });
  it("Codex only", () => {
    process.env.KICKBACKS_CC_TARGET = "/nope";
    process.env.VIBE_ADS_CC_TARGET = "/nope";
    process.env.KICKBACKS_CODEX_TARGET = codexTarget();
    process.env.VIBE_ADS_CODEX_TARGET = codexTarget();
    expect(discover().map((x) => x.id)).toEqual(["codex"]);
  });
  it("both -> claude-code first (primary precedence)", () => {
    process.env.KICKBACKS_CC_TARGET = ccTarget();
    process.env.VIBE_ADS_CC_TARGET = ccTarget();
    process.env.KICKBACKS_CODEX_TARGET = codexTarget();
    process.env.VIBE_ADS_CODEX_TARGET = codexTarget();
    expect(discover().map((x) => x.id)).toEqual(["claude-code", "codex"]);
  });
  it("adapters are constructed and typed", () => {
    process.env.KICKBACKS_CC_TARGET = ccTarget();
    process.env.VIBE_ADS_CC_TARGET = ccTarget();
    process.env.KICKBACKS_CODEX_TARGET = codexTarget();
    process.env.VIBE_ADS_CODEX_TARGET = codexTarget();
    const d = discover();
    expect(d.find((x) => x.id === "codex")!.adapter.name).toBe("codex");
    expect(d.find((x) => x.id === "claude-code")!.adapter.name)
      .toBe("claude-code");
  });
});
