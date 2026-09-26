// SPDX-License-Identifier: AGPL-3.0-only
// The recorded frames of a turn that fans out to subagents, read by the two
// files that test what the adapter makes of them. The launching calls and the
// CLI's own handles for the subagents they started are read off the fixture
// rather than spelled again in a case, so a re-recording moves them in one
// place; the file's own provenance line says what was measured and when.
import { readFileSync } from "node:fs";

export function subagentFixtureLines(): string[] {
  const raw = readFileSync(new URL("./fixtures/subagent-stream.jsonl", import.meta.url), "utf8");
  return raw.split("\n").filter(line => line.trim().length > 0);
}

const frames = (): Record<string, unknown>[] => subagentFixtureLines().map(line => JSON.parse(line) as Record<string, unknown>);
const launches = frames().filter(e => e["type"] === "system" && e["subtype"] === "task_started");

export const AGENT_A_CALL = launches[0]!["tool_use_id"] as string;
export const AGENT_B_CALL = launches[1]!["tool_use_id"] as string;
export const AGENT_A_ID = launches[0]!["task_id"] as string;

/** One frame of that fixture, by whatever tells it from the rest. */
export const subagentFixtureFrame = (holds: (event: Record<string, unknown>) => boolean): string =>
  subagentFixtureLines().find(line => holds(JSON.parse(line) as Record<string, unknown>))!;
