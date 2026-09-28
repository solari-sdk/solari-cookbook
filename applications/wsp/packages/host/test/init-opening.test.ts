// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { stateFileLine } from "@wsp/protocol";
import { TAGLINE, WORDMARK, opening, wordmark } from "../src/init-opening.js";

const STATE = "/Users/z/.wsp/state.json";

function capture(): { output: PassThrough; text(): string; raw(): string } {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return { output, text: () => stripVTControlCharacters(chunks.join("")), raw: () => chunks.join("") };
}

describe("wsp init opening", () => {
  it("on a terminal: the wordmark in greys, then the badge line with the tagline and version opens the frame", () => {
    const c = capture();
    opening({ output: c.output, isTTY: true, env: { TERM: "xterm-256color" } }, { command: "init", version: "0.1.0", yes: false, statePath: STATE });
    const lines = c.text().split("\n");
    expect(lines[0]).toBe("");
    expect(lines.slice(1, 7)).toEqual(WORDMARK);
    expect(lines[7]).toBe("");
    expect(lines[8]).toBe(`┌   init   ${TAGLINE}  0.1.0`);
    // The state file this run sets up, before anything is read: a second init lands on the upgrade unless --state moves it.
    expect(lines.slice(9, 11)).toEqual(["│", `│  ${stateFileLine(STATE)}`]);
    expect(c.raw()).toContain("\x1b[38;5;250m██");
    expect(c.text()).not.toMatch(/—|!/);
  });

  it("each row is a step darker and the outline is darker than the blocks", () => {
    const rows = wordmark();
    expect(rows[0]).toContain("\x1b[38;5;250m██\x1b[39m\x1b[38;5;237m╗\x1b[39m");
    expect(rows[1]).toContain("\x1b[38;5;248m██\x1b[39m");
    expect(rows[5]).not.toContain("\x1b[38;5;240m");
    expect(rows.map(r => stripVTControlCharacters(r))).toEqual(WORDMARK);
    expect(new Set(WORDMARK.map(r => r.length)).size).toBe(1);
  });

  it("NO_COLOR, TERM=dumb and a 16-colour terminal keep the letters and drop the shades", () => {
    for (const env of [{ TERM: "xterm-256color", NO_COLOR: "1" }, { TERM: "dumb" }, { TERM: "xterm" }]) {
      const c = capture();
      opening({ output: c.output, isTTY: true, env }, { command: "init", version: "0.1.0", yes: false, statePath: STATE });
      expect(c.raw()).not.toContain("\x1b[38;5;");
      expect(c.text().split("\n").slice(1, 7)).toEqual(WORDMARK);
    }
  });

  it("off a terminal, and under --yes, one plain line with the version and the state file under it", () => {
    for (const io of [
      { isTTY: false, yes: false },
      { isTTY: true, yes: true },
    ]) {
      const c = capture();
      opening({ output: c.output, isTTY: io.isTTY, env: {} }, { command: "init", version: "0.1.0", yes: io.yes, statePath: STATE });
      expect(c.text()).toBe(`┌  wsp 0.1.0\n│\n│  ${stateFileLine(STATE)}\n`);
    }
  });

  it("the state line says which file and the flag that starts a fresh one, and stands back from the badge above it", () => {
    const c = capture();
    opening({ output: c.output, isTTY: true, env: { TERM: "xterm-256color" } }, { command: "init", version: "0.1.0", yes: false, statePath: STATE });
    expect(c.text()).toContain(`Setting up ${STATE}; --state <path> starts a fresh setup instead.`);
    expect(c.raw()).toContain(`\x1b[38;5;243m${stateFileLine(STATE)}`);
    expect(c.text()).not.toMatch(/—|!/);
  });
});
