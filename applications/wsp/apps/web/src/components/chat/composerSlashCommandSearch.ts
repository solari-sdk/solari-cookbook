// Adapted from pingdotgg/t3code apps/web/src/components/chat/composerSlashCommandSearch.ts at 57a66608 (MIT).
// Differs from upstream: the built-in and skill item arms went with the
// menu's; the scoring and the prompt-start rule are unchanged.
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "../../lib/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";

/**
 * A provider expands a slash command only when it opens the whole message;
 * anywhere else it reaches the agent as literal text, so it is not offered
 * there.
 */
export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<ComposerCommandItem>,
  isAtPromptStart: boolean,
): ComposerCommandItem[] {
  if (isAtPromptStart) {
    return [...items];
  }
  return items.filter((item) => item.type !== "provider-slash-command");
}

function scoreSlashCommandItem(item: ComposerCommandItem, query: string): number | null {
  const primaryValue = item.command.name.toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchSlashCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
  query: string,
): ComposerCommandItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: ComposerCommandItem;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker: `1\u0000${item.command.name}\u0000${item.harness}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
