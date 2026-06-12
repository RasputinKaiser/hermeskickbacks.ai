import { describe, it, expect } from "vitest";
import { ImpressionDedupe } from "../src/metrics/dedupe";

describe("ImpressionDedupe", () => {
  it("allows the first impression of a kind+adId, blocks repeats", () => {
    const d = new ImpressionDedupe();
    expect(d.shouldSend("impression_rendered", "ad1")).toBe(true);
    expect(d.shouldSend("impression_rendered", "ad1")).toBe(false);
  });
  it("keys by kind AND adId (different kind or ad is independent)", () => {
    const d = new ImpressionDedupe();
    expect(d.shouldSend("impression_rendered", "ad1")).toBe(true);
    expect(d.shouldSend("impression_viewable", "ad1")).toBe(true);
    expect(d.shouldSend("impression_rendered", "ad2")).toBe(true);
  });
  it("keys by surface so overlay+banner of the same ad are independent", () => {
    const d = new ImpressionDedupe();
    // Same kind + same ad, different surface: each fires once.
    expect(d.shouldSend("impression_viewable", "ad1", "overlay")).toBe(true);
    expect(d.shouldSend("impression_viewable", "ad1", "banner")).toBe(true);
    expect(d.shouldSend("impression_viewable", "ad1", "codex_overlay")).toBe(true);
    expect(d.shouldSend("impression_viewable", "ad1", "statusline")).toBe(true);
    // And then each is deduped within its surface.
    expect(d.shouldSend("impression_viewable", "ad1", "overlay")).toBe(false);
    expect(d.shouldSend("impression_viewable", "ad1", "banner")).toBe(false);
  });
  it("treats missing surface as a 'default' bucket", () => {
    const d = new ImpressionDedupe();
    expect(d.shouldSend("impression_rendered", "ad1")).toBe(true);
    expect(d.shouldSend("impression_rendered", "ad1", undefined)).toBe(false);
    // Surface-tagged form is independent of the default bucket.
    expect(d.shouldSend("impression_rendered", "ad1", "overlay")).toBe(true);
  });
});
