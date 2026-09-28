// SPDX-License-Identifier: AGPL-3.0-only
// Roving focus over a list's row buttons: one of them is in the Tab order,
// the arrows move between them past group labels, Home and End jump. A row's
// own action is its next sibling in the Tab order, so Tab from a row reaches
// it.
import type { KeyboardEvent } from "react";

const ROWS = "[data-row-trigger]";

/** Puts one row in the Tab order and focuses it. */
export function focusRow(rows: readonly HTMLElement[], at: number): void {
  const target = rows[at];
  if (target === undefined) return;
  for (const row of rows) row.tabIndex = row === target ? 0 : -1;
  target.focus();
}

export function rovingKeys(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(ROWS)];
  const at = rows.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
  focusRow(rows, next);
}
