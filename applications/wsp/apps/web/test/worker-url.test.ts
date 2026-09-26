// SPDX-License-Identifier: AGPL-3.0-only
// The diff highlighter runs in a web worker that arrives through Vite's
// ?worker import; this proves our Vite resolves the package's worker entry.
import { describe, expect, it } from "vitest";
import workerUrl from "@pierre/diffs/worker/worker.js?worker&url";

describe("diff worker import", () => {
  it("resolves @pierre/diffs' worker entry to a served module URL", () => {
    expect(workerUrl).toMatch(/@pierre\/diffs\/dist\/worker\/worker\.js\?worker_file&type=module$/);
  });
});
