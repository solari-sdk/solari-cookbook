/**
 * Sweeps sandboxes a cancelled CI run may have left behind.
 *
 * Every check kills what it creates in a `finally`, but a workflow cancelled
 * mid-step kills the process outright and `finally` never runs. This is the net
 * for that case, and it runs with `if: always()` so a cancelled or failed job
 * still reaches it.
 *
 * Only sandboxes tagged `createdBy: solari-doctor` are touched, so a run on a
 * shared account cannot destroy someone else's work.
 *
 * Browser sessions have no list endpoint, so they cannot be swept the same way.
 * They release themselves at the plan deadline on their own.
 *
 *   usage: node ci/cleanup.mjs
 */

import { SolariClient } from "@solarisdk/sdk";

const apiKey = process.env.SOLARI_API_KEY;
if (!apiKey) {
  console.error("cleanup: SOLARI_API_KEY is not set");
  process.exit(1);
}

const client = new SolariClient({ apiKey });
let swept = 0;
let failed = 0;

try {
  for await (const sandbox of client.sandboxes.listAll({
    state: "running",
    metadata: { createdBy: "solari-doctor" },
  })) {
    try {
      await client.sandboxes.kill(sandbox.sandboxId);
      swept += 1;
      console.log(`cleanup: killed ${sandbox.sandboxId}`);
    } catch (error) {
      failed += 1;
      console.error(`cleanup: could not kill ${sandbox.sandboxId}: ${String(error)}`);
    }
  }
} catch (error) {
  console.error(`cleanup: listing failed: ${String(error)}`);
  process.exit(1);
}

console.log(`cleanup: ${swept} swept, ${failed} failed`);
// A leftover that could not be killed is worth failing the job over: it is a
// resource still running on someone's account.
process.exit(failed > 0 ? 1 : 0);
