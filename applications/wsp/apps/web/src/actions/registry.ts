// SPDX-License-Identifier: AGPL-3.0-only
// The shape every action registry shares. An entry is one action of one
// object kind: its words, its enabled rule over the object's state and the
// verbs the client has, its keybinding from the one table, and its handler.
// resolveActions binds a registry to one object so every surface (palette,
// row button, Machine tab, context menu) reads the same list, and toMenuItems
// serializes that list for a menu, native or in-app.
import type { LucideIcon } from "lucide-react";
import type { ContextMenuItem } from "@wsp/protocol";
import { acceleratorForCommand, shortcutLabelForCommand, type ShortcutMatchOptions } from "../keybindings.js";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "../keybindingTypes.js";

export interface ActionEntry<Target, Verbs> {
  readonly id: string;
  /** Rows of one group sit together; a separator parts the groups in a menu. */
  readonly group: string;
  readonly icon?: (target: Target) => LucideIcon;
  readonly shortcutCommand?: KeybindingCommand;
  readonly destructive?: boolean;
  /** What the palette matches beyond the title. */
  readonly searchTerms?: ReadonlyArray<string>;
  /** Whether this object takes the action at all. An action a kind or a state can never take is not drawn: a row
   * held with a reason a person can never clear is furniture, and five of them were most of a workspace's menu.
   * Absent here means the action is always offered, held or not. */
  readonly applies?: (target: Target) => boolean;
  readonly title: (target: Target) => string;
  /** The label of this action's button on the object's own row; absent for an action no row carries. */
  readonly rowLabel?: (target: Target) => string;
  /** The word that button shows, when it shows one: Pause, Wake, Waking. */
  readonly buttonWord?: (target: Target) => string;
  /** That button's hover text while the action can run; the refusal takes its place while it cannot. */
  readonly hint?: (target: Target) => string;
  /** Why the action cannot run right now, or null when it can. */
  readonly refusal: (target: Target, verbs: Verbs) => string | null;
  readonly run: (target: Target, verbs: Verbs) => void | Promise<void>;
}

export interface ResolvedAction {
  readonly id: string;
  readonly group: string;
  readonly icon?: LucideIcon;
  readonly shortcutCommand?: KeybindingCommand;
  readonly destructive: boolean;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: string;
  readonly rowLabel: string | null;
  readonly buttonWord: string | null;
  readonly hint: string | null;
  readonly refusal: string | null;
  readonly run: () => Promise<void>;
}

/** A row button's label: the entry's row label, or its title for an entry no row carries. */
export const rowLabelOf = (action: ResolvedAction): string => action.rowLabel ?? action.title;

/** The registry's actions bound to one object: every entry this object takes, so a surface draws the list it is
 * handed and decides nothing itself. */
export function resolveActions<Target, Verbs>(registry: ReadonlyArray<ActionEntry<Target, Verbs>>, target: Target, verbs: Verbs): ResolvedAction[] {
  return registry
    .filter(entry => entry.applies?.(target) ?? true)
    .map(entry => ({
      id: entry.id,
      group: entry.group,
      ...(entry.icon !== undefined ? { icon: entry.icon(target) } : {}),
      ...(entry.shortcutCommand !== undefined ? { shortcutCommand: entry.shortcutCommand } : {}),
      destructive: entry.destructive === true,
      searchTerms: entry.searchTerms ?? [],
      title: entry.title(target),
      rowLabel: entry.rowLabel?.(target) ?? null,
      buttonWord: entry.buttonWord?.(target) ?? null,
      hint: entry.hint?.(target) ?? null,
      refusal: entry.refusal(target, verbs),
      run: async () => {
        await entry.run(target, verbs);
      },
    }));
}

/** The one action with this id; a list without it is a programming error, not a state. Read for an action every
 * object takes. */
export function actionById(actions: ReadonlyArray<ResolvedAction>, id: string): ResolvedAction {
  const found = actionIfAny(actions, id);
  if (found === undefined) throw new Error(`no action ${id}`);
  return found;
}

/** The action with this id where this object takes it at all; undefined where it does not. Read for the actions a
 * kind or a state decides, whose surface draws nothing when they are not there. */
export function actionIfAny(actions: ReadonlyArray<ResolvedAction>, id: string): ResolvedAction | undefined {
  return actions.find(action => action.id === id);
}

/** The items for a menu; shortcuts resolve against the focus context the menu opens in (a terminal's menu reads the terminal's chords). */
export function toMenuItems(actions: ReadonlyArray<ResolvedAction>, keybindings: ResolvedKeybindingsConfig, shortcuts?: ShortcutMatchOptions): ContextMenuItem[] {
  return actions.map(action => {
    const shortcut = action.shortcutCommand === undefined ? null : shortcutLabelForCommand(keybindings, action.shortcutCommand, shortcuts);
    const accelerator = action.shortcutCommand === undefined ? null : acceleratorForCommand(keybindings, action.shortcutCommand, shortcuts);
    return {
      id: action.id,
      label: action.title,
      group: action.group,
      enabled: action.refusal === null,
      ...(action.refusal !== null ? { refusal: action.refusal } : {}),
      ...(shortcut !== null ? { shortcut } : {}),
      ...(accelerator !== null ? { accelerator } : {}),
      ...(action.destructive ? { destructive: true } : {}),
    };
  });
}
