// SPDX-License-Identifier: AGPL-3.0-only
// The dev CLI keeps no registry of its own: what it hands createRuntime is the
// runtime's table, so every agent the app can open a thread on is a harness a
// turn here can name, and the config dir claude runs under is the catalog's.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CONFIG_DIR, THREAD_AGENTS } from "@wsp/catalog";
import { describe, expect, it, onTestFinished } from "vitest";
import { claudeEnvs, makeRuntime } from "../src/main.js";

/** A checkout the CLI will read keys from, so no test touches the repo's own .env. */
function fakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wspx-adapters-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".env"), "SOLARI_API_KEY=slr_live_fake\nANTHROPIC_API_KEY=sk-ant-x\n");
  return root;
}

describe("the agents wspx hands the runtime", () => {
  it("is every agent wsp can open a thread on, not claude alone", async () => {
    const { rt } = makeRuntime(fakeRoot());
    const offered = (await rt.harnesses.list()).map(c => c.harness);
    expect(offered.sort()).toEqual([...THREAD_AGENTS].sort());
  });

  it("runs claude under the catalog's guest config dir, not a literal of its own", () => {
    expect(claudeEnvs("sk-ant-x")["CLAUDE_CONFIG_DIR"]).toBe(CLAUDE_CONFIG_DIR);
  });
});
