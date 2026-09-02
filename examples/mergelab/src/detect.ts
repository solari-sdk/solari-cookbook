import type { BrowserEnabledMode } from "./types.js";

const BROWSER_TEST_FRAMEWORKS = new Set([
  "@playwright/test",
  "playwright",
  "cypress",
  "puppeteer",
  "selenium-webdriver",
  "webdriverio",
  "@webdriverio/cli",
]);

export type BrowserDetection = {
  run: boolean;
  reason: string;
  detectedFramework: string | null;
};

export function detectBrowserFramework(packageJson: unknown): string | null {
  if (!packageJson || typeof packageJson !== "object") return null;

  const deps = [
    Object.entries((packageJson as Record<string, unknown>).dependencies ?? {}),
    Object.entries((packageJson as Record<string, unknown>).devDependencies ?? {}),
  ].flat();

  for (const [name] of deps) {
    if (BROWSER_TEST_FRAMEWORKS.has(name)) {
      return name;
    }
  }

  return null;
}

export function resolveBrowserVerification(
  enabled: BrowserEnabledMode,
  packageJson: unknown,
): BrowserDetection {
  if (enabled === false) {
    return {
      run: false,
      reason: "Browser verification disabled in config",
      detectedFramework: detectBrowserFramework(packageJson),
    };
  }

  const framework = detectBrowserFramework(packageJson);

  if (enabled === true) {
    return {
      run: true,
      reason: framework
        ? `Browser verification enabled explicitly (detected ${framework})`
        : "Browser verification enabled explicitly",
      detectedFramework: framework,
    };
  }

  // enabled === "auto"
  if (framework) {
    return {
      run: true,
      reason: `Auto-detected browser test framework: ${framework}`,
      detectedFramework: framework,
    };
  }

  return {
    run: false,
    reason: "No browser test framework detected in package.json (auto)",
    detectedFramework: null,
  };
}
