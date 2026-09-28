// SPDX-License-Identifier: AGPL-3.0-only
// Words the composer's pickers put on their buttons.
import type { HarnessOption } from "@wsp/protocol";

/** The word the folded picker wears with nothing picked, and what its name leads with. */
export const REASONING_WORD = "Reasoning";
export const ACCESS_WORD = "Access";

/** The reasoning button: the effort as its row names it, and the context window after it where one is picked. */
export function reasoningLabel(effort: HarnessOption | undefined, window: HarnessOption | undefined): string {
  const parts = [effort, window].map(option => option?.short ?? option?.label).filter((word): word is string => word !== undefined);
  return parts.length === 0 ? REASONING_WORD : parts.join(" ");
}

/** The access button: the mode in its short form where the row has one, since a long one crowds the bar. */
export const accessLabel = (access: HarnessOption | undefined): string => access?.short ?? access?.label ?? ACCESS_WORD;
