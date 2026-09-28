// SPDX-License-Identifier: AGPL-3.0-only
// The creation log's own lines: the ones a create's stages already carry are
// the runtime's words, folded straight in, and this file words the other half,
// the image being built at the computer or provider the workspace is going to
// the first time that one needs a copy. Every stage word is the protocol's
// GOLDEN_STAGE_WORDS, the table the init screens and the terminal read too, so
// a stage is never named twice in two spellings.
import { GOLDEN_STAGE_WORDS, type GoldenStageEvent } from "@wsp/protocol";

/** What the log says while the image is built somewhere else, with the stage's own words after it. The build runs
 * before the workspace can start, so the line names the computer rather than the workspace. */
export const imageBuildLine = (place: string, stage: string): string => `building your image on ${place}: ${stage}`;

/** One line for a golden stage frame carrying a place, or nothing for a frame the log has nothing to say about:
 * the seal and the failure are the create's own to report, and a stage with no word is not a person's business.
 * The frame's detail rides as the notice under the line, which is where the log puts what a step answered. */
export function imageBuildFrame(e: Pick<GoldenStageEvent, "stage" | "detail">, place: string): { message: string; notice?: string } | undefined {
  const word = e.stage === "failed" ? undefined : GOLDEN_STAGE_WORDS[e.stage];
  if (word === undefined) return undefined;
  return { message: imageBuildLine(place, word.charAt(0).toLowerCase() + word.slice(1)), ...(e.detail === undefined ? {} : { notice: e.detail }) };
}
