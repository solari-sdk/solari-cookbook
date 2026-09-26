// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { diskTone, sizeTone } from "../src/init-weight.js";

const MIB = 1024 * 1024;

describe("the tone a row's size takes", () => {
  it("is the protocol's table on the terminal's colours: plain under 100 MB, yellow from 100, bright yellow from 300, red from a gigabyte", () => {
    expect(sizeTone(undefined)).toBeUndefined();
    expect(sizeTone(100 * MIB - 1)).toBeUndefined();
    expect(sizeTone(100 * MIB)).toBe("yellow");
    expect(sizeTone(300 * MIB)).toBe("yellowBright");
    expect(sizeTone(1024 * MIB)).toBe("red");
  });
});

describe("the Disk line's tone", () => {
  it("is the protocol's disk table on the terminal's colours: plain under 70 percent of the room, bright yellow from 70, red from 90, over the room included", () => {
    const room = 1000 * MIB;
    expect(diskTone(0, room)).toBeUndefined();
    expect(diskTone(700 * MIB - 1, room)).toBeUndefined();
    expect(diskTone(700 * MIB, room)).toBe("yellowBright");
    expect(diskTone(900 * MIB - 1, room)).toBe("yellowBright");
    expect(diskTone(900 * MIB, room)).toBe("red");
    expect(diskTone(1500 * MIB, room)).toBe("red");
  });
});
