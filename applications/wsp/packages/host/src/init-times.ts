// SPDX-License-Identifier: AGPL-3.0-only
// How long the last build on this computer took, stage by stage: written into
// the import result at the seal, read back when the next wsp init offers a
// rebuild, so the estimate is the measured one and not a constant.
import { existsSync, readFileSync } from "node:fs";
import { BUILD_TAKES_UNMEASURED } from "@wsp/protocol";
import type { StageView } from "./init.js";

export interface BuildTimes {
  /** When the seal finished, ISO 8601. */
  at: string;
  /** Milliseconds each clocked stage of the build and the seal ran, in the order they ran. */
  stages: Record<string, number>;
}

/** The stages the streams clocked, or nothing when a stage before a closing one has no clock: the builder already
 * held it, so the run was not a rebuild and measures none. */
export function buildTimes(views: readonly StageView[], at: Date): BuildTimes | undefined {
  const stages: Record<string, number> = {};
  for (const view of views) {
    for (const [i, step] of view.steps.entries()) {
      if (step.ms === undefined) {
        if (i === view.steps.length - 1) continue;
        return undefined;
      }
      stages[step.stage] = step.ms;
    }
  }
  return Object.keys(stages).length === 0 ? undefined : { at: at.toISOString(), stages };
}

/** The record the last seal left in the import result, or nothing when the file, the record or its shape is missing. */
export function readBuildTimes(path: string): BuildTimes | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("build" in parsed)) return undefined;
  const build = parsed.build;
  if (typeof build !== "object" || build === null || !("at" in build) || !("stages" in build)) return undefined;
  const { at, stages } = build;
  if (typeof at !== "string" || typeof stages !== "object" || stages === null) return undefined;
  const entries = Object.entries(stages);
  if (entries.length === 0 || !entries.every(([, ms]) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) return undefined;
  return { at, stages: Object.fromEntries(entries) as Record<string, number> };
}

/** How long the last build ran, to the minute, and whether it was measured here at all. */
function length(last: BuildTimes | undefined): { words: string; measured: boolean } {
  if (last === undefined) return { words: BUILD_TAKES_UNMEASURED, measured: false };
  const total = Object.values(last.stages).reduce((a, b) => a + b, 0);
  if (total < 60_000) return { words: "under a minute", measured: true };
  const minutes = Math.round(total / 60_000);
  return { words: minutes === 1 ? "about a minute" : `about ${minutes} minutes`, measured: true };
}

/** What a rebuild from scratch is said to take, in the offer's frame ("a rebuild is the safer road, ..."). */
export function rebuildEstimate(last: BuildTimes | undefined): string {
  const { words, measured } = length(last);
  return measured ? `${words} last time` : `${words}, not measured on this computer yet`;
}

/** The same length in the build screen's frame ("The build takes ..., at about $x/hr"). */
export function buildTakes(last: BuildTimes | undefined): string {
  const { words, measured } = length(last);
  return measured ? `${words}, going by the last one` : `${words}, not measured on this computer yet`;
}
