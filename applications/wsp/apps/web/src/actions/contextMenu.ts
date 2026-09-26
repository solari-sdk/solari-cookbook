// SPDX-License-Identifier: AGPL-3.0-only
// One door for every context menu: the items come from a registry, and the
// menu is the native one through the desktop bridge when the page runs in the
// shell, or the in-app menu the host component draws in a browser tab. Either
// way the chosen action runs here, and a failure lands in the toast under the
// action's own title, as the palette does.
import { create } from "zustand";
import type { ContextMenuItem } from "@wsp/protocol";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import type { ShortcutMatchOptions } from "../keybindings.js";
import { noticeFailure } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import type { Point } from "./menuPlacement.js";
import { toMenuItems, type ResolvedAction } from "./registry.js";

export interface OpenMenu {
  /** Counts every opening, so a menu reopened at the same point starts afresh. */
  readonly seq: number;
  readonly items: ReadonlyArray<ContextMenuItem>;
  readonly at: Point;
  /** What had focus when the menu opened; it gets focus back when the menu closes. */
  readonly returnTo: HTMLElement | null;
  readonly choose: (id: string | null) => void;
}

interface ContextMenuState {
  menu: OpenMenu | null;
  open: (items: ReadonlyArray<ContextMenuItem>, at: Point, returnTo: HTMLElement | null) => Promise<string | null>;
  /** Closes with the chosen id, or null for a dismissal; a menu already closed is left alone. */
  choose: (id: string | null) => void;
}

let openings = 0;

export const useContextMenuStore = create<ContextMenuState>((set, get) => ({
  menu: null,
  open: (items, at, returnTo) =>
    new Promise(resolve => {
      get().menu?.choose(null);
      set({
        menu: {
          seq: ++openings,
          items,
          at,
          returnTo,
          choose: id => {
            set({ menu: null });
            returnTo?.focus({ preventScroll: true });
            resolve(id);
          },
        },
      });
    }),
  choose: id => get().menu?.choose(id),
}));

/** Where the menu opens: at the pointer, or under the element for a menu asked for from the keyboard, which carries no pointer. */
export function anchorOf(event: { clientX: number; clientY: number; currentTarget: EventTarget | null }): Point {
  if ((event.clientX !== 0 || event.clientY !== 0) || !(event.currentTarget instanceof Element)) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/** Where focus goes when the menu closes: what held it, else the row the caller names, else the element the menu was asked on. */
function returnTargetOf(event: { currentTarget: EventTarget | null }, row: HTMLElement | null | undefined): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  if (row) return row;
  return event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
}

export interface ContextMenuOptions {
  /** The focus context the chords are read in, for a menu over a surface that owns some of them. */
  readonly shortcuts?: ShortcutMatchOptions;
  /** The row focus returns to when the menu closes and nothing held focus before; the element the menu was asked on otherwise. */
  readonly returnTo?: HTMLElement | null;
}

export function runAction(action: ResolvedAction): Promise<void> {
  return action.run().catch((error: unknown) => {
    noticeFailure(error, said => `${action.title}: ${said}`);
  });
}

/** Opens the menu for these actions where the event says and runs what is chosen; the browser's own menu never shows. */
export async function openContextMenu(
  event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number; currentTarget: EventTarget | null },
  actions: ReadonlyArray<ResolvedAction>,
  options: ContextMenuOptions = {},
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  const items = toMenuItems(actions, DEFAULT_RESOLVED_KEYBINDINGS, options.shortcuts);
  const bridge = typeof window === "undefined" ? undefined : window.wsp?.contextMenu;
  const chosen =
    bridge !== undefined
      ? await bridge([...items]).catch((error: unknown) => {
          noticeFailure(error, said => `Menu: ${said}`);
          return null;
        })
      : await useContextMenuStore.getState().open(items, anchorOf(event), returnTargetOf(event, options.returnTo));
  if (chosen === null) return;
  const action = actions.find(candidate => candidate.id === chosen);
  if (action === undefined || action.refusal !== null) return;
  await runAction(action);
}
