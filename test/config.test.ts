import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKEND_BASE,
  DEFAULT_POLL_MS,
  DEFAULT_UPDATE_BASE,
  resolveBackendBase,
  resolveUpdateBase,
  type VibeAdsConfig,
} from "../src/config";

function cfg(overrides: Partial<VibeAdsConfig> = {}): VibeAdsConfig {
  return {
    backendBaseUrl: "",
    updateBaseUrl: "",
    localVsixPath: "",
    updatePollIntervalMs: DEFAULT_POLL_MS,
    debugMode: false,
    ...overrides,
  };
}

describe("service base resolution", () => {
  it("uses official Kickbacks.ai defaults when no override is set", () => {
    expect(resolveBackendBase(cfg(), undefined)).toBe(DEFAULT_BACKEND_BASE);
    expect(resolveUpdateBase(cfg(), undefined)).toBe(DEFAULT_UPDATE_BASE);
  });

  it("accepts official endpoint origins and trims trailing slashes", () => {
    expect(resolveBackendBase(cfg({ backendBaseUrl: `${DEFAULT_BACKEND_BASE}/` }), undefined))
      .toBe(DEFAULT_BACKEND_BASE);
    expect(resolveUpdateBase(cfg({ updateBaseUrl: `${DEFAULT_UPDATE_BASE}/` }), undefined))
      .toBe(DEFAULT_UPDATE_BASE);
  });

  it("keeps loopback overrides available for local development", () => {
    expect(resolveBackendBase(cfg(), "http://127.0.0.1:6080/"))
      .toBe("http://127.0.0.1:6080");
    expect(resolveUpdateBase(cfg({ updateBaseUrl: "http://localhost:6081/" }), undefined))
      .toBe("http://localhost:6081");
  });

  it("ignores unrelated external API hosts", () => {
    expect(resolveBackendBase(cfg({ backendBaseUrl: "https://example.com" }), undefined))
      .toBe(DEFAULT_BACKEND_BASE);
    expect(resolveBackendBase(cfg(), "https://evil.invalid")).toBe(DEFAULT_BACKEND_BASE);
    expect(resolveUpdateBase(cfg({ updateBaseUrl: "https://example.com" }), undefined))
      .toBe(DEFAULT_UPDATE_BASE);
    expect(resolveUpdateBase(cfg(), "https://evil.invalid")).toBe(DEFAULT_UPDATE_BASE);
  });
});
