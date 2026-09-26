// SPDX-License-Identifier: AGPL-3.0-only
// The port base a copy on a computer whose copies share its network is handed.
import { describe, expect, it } from "vitest";
import { PORT_BASE_FIRST, PORT_BASE_STEP } from "@wsp/protocol";
import { NO_PORT_BASE_LEFT, nextPortBase, PORT_BASE_LAST } from "../src/ports.js";

describe("the port base the next copy takes", () => {
  it("is the first one no copy here holds, counting up in steps", () => {
    expect(nextPortBase([])).toBe(PORT_BASE_FIRST);
    expect(nextPortBase([PORT_BASE_FIRST])).toBe(PORT_BASE_FIRST + PORT_BASE_STEP);
    expect(nextPortBase([PORT_BASE_FIRST, PORT_BASE_FIRST + PORT_BASE_STEP])).toBe(PORT_BASE_FIRST + 2 * PORT_BASE_STEP);
  });

  it("is a base a delete freed before it is one nothing has held, so the numbers stay small", () => {
    expect(nextPortBase([PORT_BASE_FIRST, PORT_BASE_FIRST + 2 * PORT_BASE_STEP])).toBe(PORT_BASE_FIRST + PORT_BASE_STEP);
  });

  it("reads the bases in any order and counts a repeat once", () => {
    const held = [PORT_BASE_FIRST + PORT_BASE_STEP, PORT_BASE_FIRST, PORT_BASE_FIRST];
    expect(nextPortBase(held)).toBe(PORT_BASE_FIRST + 2 * PORT_BASE_STEP);
  });

  it("says the range is full rather than handing out a port nothing can bind", () => {
    const all: number[] = [];
    for (let base = PORT_BASE_FIRST; base <= PORT_BASE_LAST; base += PORT_BASE_STEP) all.push(base);
    expect(() => nextPortBase(all)).toThrow(NO_PORT_BASE_LEFT);
    // The last base in the range still leaves a whole step of ports under the ceiling, and the next one would not.
    expect(nextPortBase(all.slice(0, -1))).toBe(PORT_BASE_LAST);
    expect(PORT_BASE_LAST + PORT_BASE_STEP - 1).toBeLessThanOrEqual(65535);
    expect(PORT_BASE_LAST + 2 * PORT_BASE_STEP - 1).toBeGreaterThan(65535);
  });

  it("sits above the ports a person's own dev server and wsp itself bind", () => {
    expect(PORT_BASE_FIRST).toBeGreaterThan(3000);
    expect(PORT_BASE_FIRST).toBeLessThan(4400);
  });
});
