// Adapted from pingdotgg/t3code apps/web/src/components/chat/ComposerCommandMenu.test.tsx at 57a66608 (MIT).
// Differs from upstream: the two skill cases are dropped with the skill arm, and the empty-state case went with the
// empty state; the one case left renders a harness command, and the order a real-sized catalog is drawn in, at rest
// and under a filter, is checked beside it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderSlashCommand } from "./adapt";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { composerCommandGroups } from "./composerCommandGroups";

const itemOf = (command: ProviderSlashCommand): ComposerCommandItem => ({
  id: `provider-slash-command:claude:${command.name}`,
  type: "provider-slash-command",
  harness: "claude",
  command,
  label: `/${command.name}`,
  description: command.description ?? "",
});

/** A catalog the size a real announcement is: a long unsourced run, then the commands four plugins named themselves
 * in, interleaved as an init lists them. The four sources are named in this order and no other, and every one of
 * them carries a row the query `re` finds, by a different kind of match: a name whose `re` opens a word after a
 * dash, one after a colon, one only a fuzzy pass reaches. Ranking the whole list before grouping put them in the
 * order of their best row instead, which is what this fixture is shaped to catch. */
const ANNOUNCED: ProviderSlashCommand[] = [
  ...Array.from({ length: 122 }, (_unused, at) => ({ name: `skill-${at}`, description: `what skill ${at} does` })),
  { name: "review", description: "review a pull request" },
  { name: "code-review:code-review", source: "code-review", description: "review the branch" },
  { name: "ralph-loop:help", source: "ralph-loop", description: "explain the loop" },
  { name: "frontend-design:refresh", source: "frontend-design", description: "reload the tokens" },
  { name: "skill-creator:x-repeat", source: "skill-creator", description: "run the last step again" },
  { name: "code-review:apply", source: "code-review", description: "apply the findings" },
  { name: "ralph-loop:cancel-ralph", source: "ralph-loop", description: "cancel the loop" },
  { name: "skill-creator:eval", source: "skill-creator", description: "score the skill" },
];
const SOURCES = ["code-review", "ralph-loop", "frontend-design", "skill-creator"];

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", () => {
    const command = { name: "model", description: "Show or change the model for this session" };
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        groups={composerCommandGroups([itemOf(command)], "")}
        triggerKind="slash-command"
        activeItemId="provider-slash-command:claude:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Show or change the model for this session");
  });

  it("draws a catalog the size a real one is under one heading per source the announcement named, each line with it", () => {
    expect(ANNOUNCED).toHaveLength(130);
    const groups = composerCommandGroups(ANNOUNCED.map(itemOf), "");

    // One group per source, in the order the announcement named them, with the unsourced run first and whole.
    expect(groups.map(group => group.label)).toEqual(["Commands", ...SOURCES]);
    expect(groups[0]!.items).toHaveLength(123);
    expect(groups[1]!.items.map(item => item.label)).toEqual(["/code-review:code-review", "/code-review:apply"]);
    expect(groups[2]!.items.map(item => item.label)).toEqual(["/ralph-loop:help", "/ralph-loop:cancel-ralph"]);

    const markup = renderToStaticMarkup(
      <ComposerCommandMenu groups={groups} triggerKind="slash-command" activeItemId={null} onHighlightedItemChange={() => {}} onSelect={() => {}} />,
    );
    for (const label of ["Commands", ...SOURCES]) expect(markup).toContain(label);
    for (const command of ANNOUNCED) {
      expect(markup, command.name).toContain(`/${command.name}`);
      expect(markup, command.name).toContain(command.description);
    }
  });

  it("keeps the heads in the order the announcement named them under a filter, and ranks only inside each", () => {
    const groups = composerCommandGroups(ANNOUNCED.map(itemOf), "re");

    // Not the order of each group's best-ranked row, which would read Commands, code-review, skill-creator,
    // frontend-design, ralph-loop here, so a head would trade places with another between two keystrokes.
    expect(groups.map(group => group.label)).toEqual(["Commands", ...SOURCES]);
    expect(groups[0]!.items.map(item => item.label)).toEqual(["/review"]);
    // Inside a group the ranking still decides, and decides exactly as it did when it ran over the whole list:
    // ranking all 130 under `re` gives review, code-review:apply, code-review:code-review, skill-creator:eval,
    // frontend-design:refresh, skill-creator:x-repeat, ralph-loop:help, ralph-loop:cancel-ralph, and every group
    // below holds its rows in that same relative order. Only the heads moved.
    expect(groups[1]!.items.map(item => item.label)).toEqual(["/code-review:apply", "/code-review:code-review"]);
    expect(groups[2]!.items.map(item => item.label)).toEqual(["/ralph-loop:help", "/ralph-loop:cancel-ralph"]);
    expect(groups[3]!.items.map(item => item.label)).toEqual(["/frontend-design:refresh"]);
    expect(groups[4]!.items.map(item => item.label)).toEqual(["/skill-creator:eval", "/skill-creator:x-repeat"]);
  });

  it("drops a group nothing in it matched", () => {
    const groups = composerCommandGroups(ANNOUNCED.map(itemOf), "x-repeat");
    expect(groups.map(group => group.label)).toEqual(["skill-creator"]);
    expect(groups[0]!.items.map(item => item.label)).toEqual(["/skill-creator:x-repeat"]);
  });
});
