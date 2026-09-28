// SPDX-License-Identifier: AGPL-3.0-only
// The one rule for the order the slash menu is drawn in: groups by the source
// the announcement named, rows by what the person typed. The palette's own
// grouping could not be shared: buildRootGroups names two fixed groups over
// palette items that carry an icon and a callback, and these are read off the
// announcement instead. What is shared is the drawing, through CommandGroup
// and CommandGroupLabel.
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

export interface ComposerCommandGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<ComposerCommandItem>;
}

/** The heading over every command whose announcement named no source. It says no more than that, because the
 * announcement says no more than that: nothing in a bare name tells a CLI's own command from a person's skill. */
const UNSOURCED = "Commands";
const UNSOURCED_VALUE = "commands";

/** The announced commands as the menu draws them: one group per source the announcement named, in the order it named
 * them, and everything it left unsourced together under one heading. The query is answered inside each group and
 * nowhere else, so a head never trades places with another between two keystrokes: ranking the whole list first put
 * the group holding the best row in front, and four heads reordered under `/re` on a real catalog. Groups nothing
 * matched go; the ranking inside the ones left is the one the search has always given.
 */
export function composerCommandGroups(items: ReadonlyArray<ComposerCommandItem>, query: string): ComposerCommandGroup[] {
  const bySource = new Map<string, ComposerCommandItem[]>();
  for (const item of items) {
    const source = item.command.source ?? "";
    const held = bySource.get(source);
    if (held === undefined) bySource.set(source, [item]);
    else held.push(item);
  }
  const groups: ComposerCommandGroup[] = [];
  for (const [source, held] of bySource) {
    const matched = searchSlashCommandItems(held, query);
    if (matched.length === 0) continue;
    groups.push({
      value: source === "" ? UNSOURCED_VALUE : `source:${source}`,
      label: source === "" ? UNSOURCED : source,
      items: matched,
    });
  }
  return groups;
}
