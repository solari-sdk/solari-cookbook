// Adapted from pingdotgg/t3code apps/web/src/components/chat/composerSlashCommandSearch.test.ts at 57a66608 (MIT).
// Differs from upstream: the skill and built-in cases are dropped with those arms; items name their harness by string.
import { describe, expect, it } from "vitest";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

const item = (name: string, description: string): ComposerCommandItem => ({
  id: `provider-slash-command:claude:${name}`,
  type: "provider-slash-command",
  harness: "claude",
  command: { name },
  label: `/${name}`,
  description,
});

describe("searchSlashCommandItems", () => {
  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      item("default", "Switch this thread back to normal build mode"),
      item("ui", "Explore, build, and refine UI."),
      item("frontend-design", "Create distinctive, production-grade frontend interfaces"),
    ];

    expect(searchSlashCommandItems(items, "ui").map((entry) => entry.id)).toEqual([
      "provider-slash-command:claude:ui",
      "provider-slash-command:claude:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [item("gh-fix-ci", "Fix failing GitHub Actions"), item("github", "General GitHub help")];

    expect(searchSlashCommandItems(items, "gfc").map((entry) => entry.id)).toEqual([
      "provider-slash-command:claude:gh-fix-ci",
    ]);
  });

  it("returns every item for an empty query, in catalog order", () => {
    const items = [item("compact", ""), item("context", "")];
    expect(searchSlashCommandItems(items, "/").map((entry) => entry.id)).toEqual([
      "provider-slash-command:claude:compact",
      "provider-slash-command:claude:context",
    ]);
  });

  it("hides provider commands from slash completion after the first message line", () => {
    const items = [item("compact", "Compact the conversation")];

    expect(slashCommandItemsForPromptPosition(items, false)).toEqual([]);
    expect(slashCommandItemsForPromptPosition(items, true).map((entry) => entry.id)).toEqual([
      "provider-slash-command:claude:compact",
    ]);
  });
});
