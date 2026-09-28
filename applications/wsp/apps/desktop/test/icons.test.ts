// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktop = fileURLToPath(new URL("..", import.meta.url));

describe("desktop icons", () => {
  it("build/icon.icns is an icns file", () => {
    const bytes = readFileSync(new URL("../build/icon.icns", import.meta.url));
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(bytes.readUInt32BE(4)).toBe(bytes.length);
  });

  it("build/icon.ico is an ico file with a 256 px entry", () => {
    const bytes = readFileSync(new URL("../build/icon.ico", import.meta.url));
    expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const count = bytes.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => bytes.readUInt8(6 + 16 * i) || 256);
    expect(sizes).toContain(256);
    expect(sizes).toContain(16);
  });

  it("electron-builder.yml points mac and win at them", () => {
    const yml = readFileSync(`${desktop}electron-builder.yml`, "utf8");
    expect(yml).toMatch(/^mac:\n(?:  .*\n)*  icon: build\/icon\.icns$/m);
    expect(yml).toMatch(/^win:\n(?:  .*\n)*  icon: build\/icon\.ico$/m);
  });
});
