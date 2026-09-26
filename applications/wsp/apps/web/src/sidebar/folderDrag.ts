// SPDX-License-Identifier: AGPL-3.0-only
// A folder dragged from the desktop over the window: what a drop carries and
// whether it is a folder at all. The page itself cannot read a dropped
// folder's path; the desktop shell's bridge does, so a field that takes a drop
// asks it. No row takes a drop any more: a project is recorded with wsp add
// and a workspace is made of one.

/** Whether a drag carries files from outside the page, which is the only kind a field takes. */
export const carriesFiles = (transfer: DataTransfer | null | undefined): boolean => Array.from(transfer?.types ?? []).includes("Files");

/** The dropped folder, or nothing when what was dropped is a file: the kind of entry is known only at the drop. */
export function droppedFolder(transfer: DataTransfer | null | undefined): File | null {
  const item = transfer?.items?.[0];
  const file = transfer?.files?.[0];
  if (item === undefined || file === undefined) return null;
  const entry = item.webkitGetAsEntry?.();
  return entry !== null && entry !== undefined && entry.isDirectory ? file : null;
}
