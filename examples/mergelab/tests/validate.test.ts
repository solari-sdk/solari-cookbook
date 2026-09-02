import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/validate.js";

const validConfig = {
  version: 1,
  install: { command: "npm ci", timeoutMs: 180000 },
  checks: [
    { name: "typecheck", command: "npm run typecheck", timeoutMs: 120000, required: true },
    { name: "tests", command: "npm test", timeoutMs: 180000, required: true },
  ],
  browser: {
    enabled: true,
    startCommand: "npm run dev",
    port: 3000,
    readyPath: "/health",
    readyTimeoutMs: 60000,
    testFile: "./verification/spec.ts",
    viewport: { width: 1440, height: 900 },
  },
};

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    expect(validateConfig(validConfig)).toBeDefined();
  });

  it("rejects unsupported version", () => {
    expect(() => validateConfig({ ...validConfig, version: 2 })).toThrow();
  });

  it("rejects duplicate check names", () => {
    expect(() =>
      validateConfig({
        ...validConfig,
        checks: [
          { name: "tests", command: "a", timeoutMs: 1000, required: true },
          { name: "tests", command: "b", timeoutMs: 1000, required: true },
        ],
      }),
    ).toThrow("Duplicate");
  });

  it("accepts auto browser mode", () => {
    expect(
      validateConfig({
        ...validConfig,
        browser: { ...validConfig.browser, enabled: "auto" },
      }),
    ).toBeDefined();
  });
});
