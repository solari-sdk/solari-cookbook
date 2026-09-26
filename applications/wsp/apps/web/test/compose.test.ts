// SPDX-License-Identifier: AGPL-3.0-only
// The compose table: for every mode and key class, what reaches the pty, what
// the terminal paints locally, and what the buffer holds afterwards.
import { describe, expect, it } from "vitest";
import { composeKey, composeMode, RAW_STATE, type ComposeState } from "../src/terminal/compose.js";

const line = (buffer = "", echo = true): ComposeState => ({ mode: "line", echo, buffer });

describe("composeKey in raw mode", () => {
  it.each([
    ["printable", "a"],
    ["Enter", "\r"],
    ["Backspace", "\x7f"],
    ["Tab", "\t"],
    ["ArrowUp", "\x1b[A"],
    ["Ctrl-C", "\x03"],
    ["Escape", "\x1b"],
    ["paste", "ls -la\r"],
  ])("passes %s through byte for byte", (_name, key) => {
    expect(composeKey(RAW_STATE, key)).toEqual({ state: RAW_STATE, toPty: key, toScreen: "" });
  });

  it("the unknown-mode default is raw", () => {
    expect(RAW_STATE.mode).toBe("raw");
    expect(RAW_STATE.buffer).toBe("");
  });
});

describe("composeKey in line mode", () => {
  it("a printable key lands in the buffer and paints locally, nothing reaches the pty", () => {
    expect(composeKey(line("l"), "s")).toEqual({ state: line("ls"), toPty: "", toScreen: "s" });
  });

  it("a pasted printable run lands whole", () => {
    expect(composeKey(line(), "git status")).toEqual({ state: line("git status"), toPty: "", toScreen: "git status" });
  });

  it("non-ASCII printable text is printable", () => {
    expect(composeKey(line(), "你好")).toEqual({ state: line("你好"), toPty: "", toScreen: "你好" });
  });

  it("Enter sends the buffer plus CR in one write and repaints nothing locally but the erase", () => {
    expect(composeKey(line("ls"), "\r")).toEqual({ state: line(), toPty: "ls\r", toScreen: "\b \b\b \b" });
  });

  it("Enter on an empty buffer sends a bare CR", () => {
    expect(composeKey(line(), "\r")).toEqual({ state: line(), toPty: "\r", toScreen: "" });
  });

  it.each(["\x7f", "\b"])("Backspace %j erases the last code point locally", key => {
    expect(composeKey(line("ab"), key)).toEqual({ state: line("a"), toPty: "", toScreen: "\b \b" });
  });

  it("Backspace erases a whole astral code point, not half a surrogate pair", () => {
    expect(composeKey(line("a😀"), "\x7f")).toEqual({ state: line("a"), toPty: "", toScreen: "\b \b" });
  });

  it("Backspace on an empty buffer passes through to the pty", () => {
    expect(composeKey(line(), "\x7f")).toEqual({ state: line(), toPty: "\x7f", toScreen: "" });
  });

  it.each([
    ["Tab", "\t"],
    ["ArrowUp", "\x1b[A"],
    ["ArrowLeft", "\x1b[D"],
    ["Ctrl-C", "\x03"],
    ["Ctrl-D", "\x04"],
    ["Escape", "\x1b"],
    ["Ctrl-J newline", "\n"],
  ])("%s flushes the buffer to the pty as-is and then passes the key", (_name, key) => {
    expect(composeKey(line("ab"), key)).toEqual({ state: line(), toPty: "ab" + key, toScreen: "\b \b\b \b" });
  });

  it("a paste containing a control byte flushes and passes the whole paste", () => {
    expect(composeKey(line("x"), "ls\rpwd\r")).toEqual({ state: line(), toPty: "xls\rpwd\r", toScreen: "\b \b" });
  });

  it("a non-printable key with an empty buffer is a plain passthrough", () => {
    expect(composeKey(line(), "\x1b[A")).toEqual({ state: line(), toPty: "\x1b[A", toScreen: "" });
  });
});

describe("composeKey in line mode with echo off", () => {
  it("buffers printable keys without painting them", () => {
    expect(composeKey(line("", false), "s")).toEqual({ state: line("s", false), toPty: "", toScreen: "" });
  });

  it("Backspace edits the buffer without painting", () => {
    expect(composeKey(line("ab", false), "\x7f")).toEqual({ state: line("a", false), toPty: "", toScreen: "" });
  });

  it("Enter sends the buffer with nothing to erase on screen", () => {
    expect(composeKey(line("hunter2", false), "\r")).toEqual({ state: line("", false), toPty: "hunter2\r", toScreen: "" });
  });
});

describe("composeMode", () => {
  it("line to raw with a non-empty buffer flushes it to the pty first and erases the local paint", () => {
    expect(composeMode(line("vi"), { mode: "raw", echo: true })).toEqual({
      state: { mode: "raw", echo: true, buffer: "" },
      toPty: "vi",
      toScreen: "\b \b\b \b",
    });
  });

  it("line to raw with an empty buffer writes nothing", () => {
    expect(composeMode(line(), { mode: "raw", echo: false })).toEqual({
      state: { mode: "raw", echo: false, buffer: "" },
      toPty: "",
      toScreen: "",
    });
  });

  it("raw to line starts an empty buffer", () => {
    expect(composeMode(RAW_STATE, { mode: "line", echo: true })).toEqual({ state: line(), toPty: "", toScreen: "" });
  });

  it("echo turning off mid-line hides the buffered text but keeps it", () => {
    expect(composeMode(line("ab"), { mode: "line", echo: false })).toEqual({
      state: line("ab", false),
      toPty: "",
      toScreen: "\b \b\b \b",
    });
  });

  it("echo turning on mid-line paints the buffered text", () => {
    expect(composeMode(line("ab", false), { mode: "line", echo: true })).toEqual({
      state: line("ab"),
      toPty: "",
      toScreen: "ab",
    });
  });

  it("a same-state report is a no-op", () => {
    expect(composeMode(line("ab"), { mode: "line", echo: true })).toEqual({ state: line("ab"), toPty: "", toScreen: "" });
  });
});
