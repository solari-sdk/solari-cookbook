import { describe, it, expect } from "vitest";
import { detectBrowserFramework, resolveBrowserVerification } from "../src/detect.js";

const makePackage = (deps: Record<string, string> = {}, devDeps: Record<string, string> = {}) => ({
  name: "test",
  dependencies: deps,
  devDependencies: devDeps,
});

describe("detectBrowserFramework", () => {
  it("detects playwright in devDependencies", () => {
    expect(detectBrowserFramework(makePackage({}, { playwright: "^1.0.0" }))).toBe("playwright");
  });

  it("detects @playwright/test in dependencies", () => {
    expect(detectBrowserFramework(makePackage({ "@playwright/test": "^1.0.0" }))).toBe("@playwright/test");
  });

  it("detects cypress", () => {
    expect(detectBrowserFramework(makePackage({}, { cypress: "^13.0.0" }))).toBe("cypress");
  });

  it("returns null when no framework is present", () => {
    expect(detectBrowserFramework(makePackage({}, { vitest: "^1.0.0" }))).toBeNull();
  });

  it("handles invalid input", () => {
    expect(detectBrowserFramework(null)).toBeNull();
    expect(detectBrowserFramework("string")).toBeNull();
  });
});

describe("resolveBrowserVerification", () => {
  it("skips when disabled", () => {
    const decision = resolveBrowserVerification(false, makePackage({}, { playwright: "^1.0.0" }));
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("disabled");
  });

  it("runs when enabled explicitly even without framework", () => {
    const decision = resolveBrowserVerification(true, makePackage());
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain("enabled explicitly");
  });

  it("runs in auto mode when framework is detected", () => {
    const decision = resolveBrowserVerification("auto", makePackage({}, { cypress: "^13.0.0" }));
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain("cypress");
    expect(decision.detectedFramework).toBe("cypress");
  });

  it("skips in auto mode when no framework is detected", () => {
    const decision = resolveBrowserVerification("auto", makePackage());
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain("No browser test framework detected");
  });
});
