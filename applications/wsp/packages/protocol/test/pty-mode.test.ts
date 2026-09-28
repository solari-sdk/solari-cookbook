// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DaemonEvent } from "../src/index.js";

describe("pty.mode daemon event", () => {
  it("round-trips line and raw states through the DaemonEvent union", () => {
    const raw = { type: "pty.mode", ptyId: "p1", mode: "raw", echo: false, foreground: "vim" };
    expect(DaemonEvent.parse(raw)).toEqual(raw);
    const line = { type: "pty.mode", ptyId: "p1", mode: "line", echo: true, foreground: "bash" };
    expect(DaemonEvent.parse(line)).toEqual(line);
    // foreground is "" when the probe cannot read it; still a valid event
    const blank = { type: "pty.mode", ptyId: "p1", mode: "line", echo: true, foreground: "" };
    expect(DaemonEvent.parse(blank)).toEqual(blank);
  });

  it("rejects unknown modes and missing fields", () => {
    expect(() =>
      DaemonEvent.parse({ type: "pty.mode", ptyId: "p1", mode: "cooked", echo: true, foreground: "" }),
    ).toThrow();
    expect(() => DaemonEvent.parse({ type: "pty.mode", ptyId: "p1", mode: "raw", echo: true })).toThrow();
  });
});
