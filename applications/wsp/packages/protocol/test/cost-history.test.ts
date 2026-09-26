// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { accruedAt, appendCostPoint, COST_HISTORY_CAP, monthStart, rateAt, spentSince, type WorkspaceCostEvent } from "../src/index.js";

const tick = (minute: number, rate: number, accruedUsd: number): WorkspaceCostEvent => ({
  type: "workspace.cost",
  workspaceId: "ws_a",
  phase: rate > 0 ? "running" : "napping",
  rateUsdPerHour: rate,
  awakeMs: minute * 60_000,
  accruedUsd,
  at: new Date(Date.UTC(2026, 8, 5, 9, minute)).toISOString(),
});

describe("appendCostPoint", () => {
  it("keeps the first tick, the newest tick and the ticks either side of a rate change, nothing between", () => {
    let points: WorkspaceCostEvent[] = [];
    for (const t of [tick(0, 0.11, 0), tick(1, 0.11, 0.1), tick(2, 0.11, 0.2), tick(3, 0.11, 0.3)]) points = appendCostPoint(points, t);
    expect(points.map(p => p.at)).toEqual([tick(0, 0, 0).at, tick(3, 0, 0).at]);
    for (const t of [tick(4, 0, 0.3), tick(5, 0, 0.3), tick(6, 0, 0.3)]) points = appendCostPoint(points, t);
    expect(points.map(p => [p.at.slice(14, 16), p.rateUsdPerHour])).toEqual([["00", 0.11], ["03", 0.11], ["04", 0], ["06", 0]]);
    for (const t of [tick(7, 0.22, 0.3), tick(8, 0.22, 0.5)]) points = appendCostPoint(points, t);
    expect(points.map(p => p.at.slice(14, 16))).toEqual(["00", "03", "04", "06", "07", "08"]);
  });

  it("returns a new array and leaves the one given alone", () => {
    const before = [tick(0, 0.11, 0), tick(1, 0.11, 0.1)];
    const after = appendCostPoint(before, tick(2, 0.11, 0.2));
    expect(before).toHaveLength(2);
    expect(after).not.toBe(before);
    expect(after.map(p => p.at.slice(14, 16))).toEqual(["00", "02"]);
  });

  it("drops the oldest points past the cap", () => {
    let points: WorkspaceCostEvent[] = [];
    for (let i = 0; i < COST_HISTORY_CAP + 10; i++) points = appendCostPoint(points, tick(i, i % 2 === 0 ? 0.11 : 0, i));
    expect(points).toHaveLength(COST_HISTORY_CAP);
    expect(points.at(-1)!.awakeMs).toBe((COST_HISTORY_CAP + 9) * 60_000);
  });
});

describe("what a series says at one instant", () => {
  const at = (minute: number): number => Date.UTC(2026, 8, 5, 9, minute);

  it("reads the total between two ticks off the line between them, and holds it past the newest", () => {
    const points = [tick(0, 0.12, 0), tick(30, 0.12, 0.06)];
    expect(accruedAt(points, at(0))).toBe(0);
    expect(accruedAt(points, at(15))).toBeCloseTo(0.03, 10);
    expect(accruedAt(points, at(30))).toBe(0.06);
    expect(accruedAt(points, at(90))).toBe(0.06);
  });

  it("says nothing at all before the first tick, which is a total nothing here knows", () => {
    expect(accruedAt([tick(10, 0.12, 0)], at(9))).toBeNull();
    expect(accruedAt([], at(9))).toBeNull();
    expect(rateAt([tick(10, 0.12, 0)], at(9))).toBeNull();
  });

  it("holds a tick's rate until the next one", () => {
    const points = [tick(0, 0.12, 0), tick(30, 0, 0.06)];
    expect(rateAt(points, at(29))).toBe(0.12);
    expect(rateAt(points, at(31))).toBe(0);
  });
});

describe("what a month took", () => {
  it("begins a month at midnight on its first day, in the zone the computer is set to", () => {
    const start = monthStart(Date.parse("2026-09-13T04:20:00.000Z"));
    const d = new Date(start);
    expect([d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([1, 0, 0, 0]);
    expect(d.getMonth()).toBe(new Date(Date.parse("2026-09-13T04:20:00.000Z")).getMonth());
    expect(monthStart(start)).toBe(start);
  });

  it("counts what a series took since an instant, taking the total at that instant off the newest", () => {
    const points = [tick(0, 0.12, 0.5), tick(60, 0.12, 0.62)];
    expect(spentSince(points, Date.UTC(2026, 8, 5, 9, 0))).toBeCloseTo(0.12, 10);
    expect(spentSince(points, Date.UTC(2026, 8, 5, 9, 30))).toBeCloseTo(0.06, 10);
  });

  it("counts the whole of a series that began after the instant, and nothing from one that ended before it", () => {
    const points = [tick(0, 0.12, 0), tick(60, 0.12, 0.12)];
    expect(spentSince(points, Date.UTC(2026, 8, 1))).toBeCloseTo(0.12, 10);
    expect(spentSince(points, Date.UTC(2026, 9, 1))).toBe(0);
    expect(spentSince([], Date.UTC(2026, 8, 1))).toBe(0);
  });
});
