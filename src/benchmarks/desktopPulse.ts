import { performance } from "node:perf_hooks";
import { SandboxClient } from "@solarisdk/sandbox";
import { config } from "../config.js";
import { describeError, round } from "../lib.js";
import type { EmitFn } from "../types.js";

// Solari does not publish a cross-provider desktop benchmark today, so
// this only times Solari against itself: create, wait for the display and
// VNC agent to report healthy, then release.
export async function runDesktopPulse(emit: EmitFn): Promise<void> {
  const sandboxes = new SandboxClient({
    apiKey: config.solariApiKey,
    baseUrl: config.solariBaseUrl,
  });

  const totalStart = performance.now();
  let desktopId: string | undefined;

  try {
    const createStart = performance.now();
    const desktop = await sandboxes.createDesktop();
    desktopId = desktop.sessionId;
    emit({ type: "stage", stage: "create", ms: round(performance.now() - createStart) });

    const readyStart = performance.now();
    await desktop.health();
    emit({ type: "stage", stage: "ready", ms: round(performance.now() - readyStart) });

    const releaseStart = performance.now();
    await desktop.kill();
    emit({ type: "stage", stage: "release", ms: round(performance.now() - releaseStart) });

    emit({ type: "done", totalMs: round(performance.now() - totalStart) });
  } catch (err) {
    if (desktopId) {
      await sandboxes.kill(desktopId).catch(() => undefined);
    }
    emit({ type: "error", message: describeError(err) });
  }
}
