// SPDX-License-Identifier: AGPL-3.0-only
// A workspace's cost history is the ticks where its burn rate changed. Between
// two ticks of one rate the accrued total is linear, so the ticks between them
// carry nothing; the runtime and the app both fold a series with this rule and
// both read a total off one with the arithmetic below.
import type { WorkspaceCostEvent } from "./index.js";

/** Rate changes on every nap, wake and upgrade; hourly flips for a month stay well under this. */
export const COST_HISTORY_CAP = 4096;

/** The series with `tick` appended: a tick that continues the rate of the two before it replaces the newest, so the
 * series holds the first tick, the last tick of each rate, the first tick of the next and the newest. Equal rates
 * stand for one straight run because the accrued total grows at the tick's rate for as long as that rate holds. */
export function appendCostPoint(points: readonly WorkspaceCostEvent[], tick: WorkspaceCostEvent): WorkspaceCostEvent[] {
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const collinear = last !== undefined && prev !== undefined && prev.rateUsdPerHour === last.rateUsdPerHour && last.rateUsdPerHour === tick.rateUsdPerHour;
  const next = collinear ? [...points.slice(0, -1), tick] : [...points, tick];
  return next.length > COST_HISTORY_CAP ? next.slice(next.length - COST_HISTORY_CAP) : next;
}

/** The tick at or before t and the one after it, when t falls inside the series. */
function around(points: readonly WorkspaceCostEvent[], t: number): { before: WorkspaceCostEvent; after: WorkspaceCostEvent | undefined } | null {
  const first = points[0];
  if (first === undefined || t < Date.parse(first.at)) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Date.parse(points[mid]!.at) <= t) lo = mid;
    else hi = mid - 1;
  }
  return { before: points[lo]!, after: points[lo + 1] };
}

/** The total accrued at t: linear between the ticks around it, flat past the newest, unknown before the first. */
export function accruedAt(points: readonly WorkspaceCostEvent[], t: number): number | null {
  const near = around(points, t);
  if (near === null) return null;
  const { before, after } = near;
  if (after === undefined) return before.accruedUsd;
  const t0 = Date.parse(before.at);
  const t1 = Date.parse(after.at);
  if (t1 <= t0) return after.accruedUsd;
  return before.accruedUsd + ((after.accruedUsd - before.accruedUsd) * (t - t0)) / (t1 - t0);
}

/** The burn rate at t: the rate of the tick at or before it, which holds until the next tick. */
export function rateAt(points: readonly WorkspaceCostEvent[], t: number): number | null {
  return around(points, t)?.before.rateUsdPerHour ?? null;
}

/** The first instant of the month `at` falls in, in the zone the computer is set to, which is the zone every
 * figure a person reads is in. One reading, so the month the chart draws and the month the places list totals
 * begin at the same instant. */
export function monthStart(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** What a series accrued between `from` and its newest tick: nothing for a series that ends before `from`, and the
 * whole of it for one that began after. A workspace deleted mid-month keeps its own share this way, since its
 * series stops where it was deleted. */
export function spentSince(points: readonly WorkspaceCostEvent[], from: number): number {
  const last = points[points.length - 1];
  if (last === undefined) return 0;
  return Math.max(0, last.accruedUsd - (accruedAt(points, from) ?? 0));
}
