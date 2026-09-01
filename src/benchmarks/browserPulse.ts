import { performance } from "node:perf_hooks";
import { Solari } from "@solarisdk/browser";
import { chromium } from "patchright-core";
import { config } from "../config.js";
import { describeError, round } from "../lib.js";
import type { EmitFn } from "../types.js";

// Mirrors the four stages Solari itself publishes on getsolari.com:
// "Create, connect, navigate, and release, measured end to end."
// solari.launch() would do create+connect in one call, so this uses the
// lower-level sessions.create() + chromium.connectOverCDP() path from the
// SDK's own README to keep each stage separate.
export async function runBrowserPulse(emit: EmitFn): Promise<void> {
  const solari = new Solari({ apiKey: config.solariApiKey });
  const totalStart = performance.now();
  let sessionId: string | undefined;

  try {
    const createStart = performance.now();
    const session = await solari.sessions.create();
    sessionId = session.id;
    emit({ type: "stage", stage: "create", ms: round(performance.now() - createStart) });

    const connectStart = performance.now();
    const browser = await chromium.connectOverCDP(session.cdpEndpoint);
    emit({ type: "stage", stage: "connect", ms: round(performance.now() - connectStart) });

    const navigateStart = performance.now();
    const page = await browser.newPage();
    await page.goto("https://example.com", { waitUntil: "load" });
    emit({ type: "stage", stage: "navigate", ms: round(performance.now() - navigateStart) });

    const releaseStart = performance.now();
    await browser.close();
    await solari.sessions.releaseAndWait(session.id);
    emit({ type: "stage", stage: "release", ms: round(performance.now() - releaseStart) });

    emit({ type: "done", totalMs: round(performance.now() - totalStart) });
  } catch (err) {
    if (sessionId) {
      solari.sessions.release(sessionId);
    }
    emit({ type: "error", message: describeError(err) });
  } finally {
    await solari.close();
  }
}
