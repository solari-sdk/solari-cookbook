// SPDX-License-Identifier: AGPL-3.0-only
// What a workspace's native menu should read, derived rather than written
// down twice. The words and their order come from the page's own workspace
// registry, the table the app builds the menu from, and the separators from
// the same template builder the main process runs, so an action added to the
// registry shows up here and no test has to be edited to match it.
import type { WorkspaceView } from "@wsp/protocol";
import { workspaceActions, workspaceTarget } from "../../web/src/actions/workspaceActions.js";
import { contextMenuTemplate } from "../src/context-menu.js";

/** One row per menu row, a separator drawn as its own mark, so labels and the places the groups part read as one list. */
export const SEPARATOR = "---";

/** A row of a menu as a test compares it: the label, or the separator mark. */
export type MenuShape = ReadonlyArray<string>;

/** The rows the main process builds for this workspace, as marks. Only the shape is read, so the entries need no
 * verbs to run with: an entry's refusal decides whether its row is dimmed, never whether the row is there. The
 * status is left out for the same reason; the one word that reads it is the phase row, and a workspace the smoke
 * has just created is running, which is what its record already says. */
export function workspaceMenuShape(workspace: WorkspaceView): MenuShape {
  // No places list: only the shape is read, and the one field that reads it is a verb's refusal, which decides
  // whether a row is dimmed rather than whether it is there.
  const target = workspaceTarget(workspace, null, []);
  // Every row this workspace takes, by the registry's own rule: an action its kind or its state cannot take is not
  // drawn in the app either, so the shape the smoke expects is the shape a person sees.
  const items = workspaceActions
    .filter(entry => entry.applies?.(target) ?? true)
    .map(entry => ({ id: entry.id, label: entry.title(target), group: entry.group, enabled: true }));
  return contextMenuTemplate(items, () => {}).map(row => (row.type === "separator" ? SEPARATOR : String(row.label)));
}

/** The same reading of rows the app actually built, so the two sides are compared in one shape. */
export function menuShapeOf(rows: ReadonlyArray<{ type?: string | undefined; label?: string | undefined }>): MenuShape {
  return rows.map(row => (row.type === "separator" ? SEPARATOR : String(row.label)));
}
