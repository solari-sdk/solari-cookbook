// SPDX-License-Identifier: AGPL-3.0-only
// The app's host lives in the app's own process, so the app restarts it by
// relaunching itself: the relaunch is asked for before the quit, and the quit
// closes the host and its lock through before-quit.
import { describe, expect, it } from "vitest";
import { appRestartRoad } from "../src/restart-road.js";

describe("the app's restart road", () => {
  it("asks for the relaunch before it quits, and touches the host only through the quit", async () => {
    const steps: string[] = [];
    const road = appRestartRoad({ relaunch: () => void steps.push("relaunch"), quit: () => void steps.push("quit") });
    expect(road.shape).toBe("app");
    expect(road.refusal).toBeUndefined();
    await road.restart({ port: 1, wsPort: 2, close: async () => void steps.push("close") });
    expect(steps).toEqual(["relaunch", "quit"]);
  });
});
