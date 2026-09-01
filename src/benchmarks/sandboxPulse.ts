import { performance } from "node:perf_hooks";
import { SandboxClient } from "@solarisdk/sandbox";
import { config } from "../config.js";
import { describeError, round } from "../lib.js";
import type { EmitFn } from "../types.js";

// Mirrors the three stages Solari publishes for sandboxes:
// "create the machine, run the code, tear it down."
export async function runSandboxPulse(emit: EmitFn): Promise<void> {
  const sandboxes = new SandboxClient({
    apiKey: config.solariApiKey,
    baseUrl: config.solariBaseUrl,
  });

  const totalStart = performance.now();
  let sandboxId: string | undefined;

  try {
    const createStart = performance.now();
    const sandbox = await sandboxes.create({ template: "base" });
    sandboxId = sandbox.sandboxId;
    emit({ type: "stage", stage: "create", ms: round(performance.now() - createStart) });

    const runStart = performance.now();
    await sandbox.commands.run("echo", { args: ["pulse"] });
    emit({ type: "stage", stage: "run", ms: round(performance.now() - runStart) });

    const releaseStart = performance.now();
    await sandbox.kill();
    emit({ type: "stage", stage: "release", ms: round(performance.now() - releaseStart) });

    emit({ type: "done", totalMs: round(performance.now() - totalStart) });
  } catch (err) {
    if (sandboxId) {
      await sandboxes.kill(sandboxId).catch(() => undefined);
    }
    emit({ type: "error", message: describeError(err) });
  }
}
