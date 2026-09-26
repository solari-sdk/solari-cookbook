// SPDX-License-Identifier: AGPL-3.0-only
// The one launch that is asked to move: a packaged mac bundle outside
// Applications, driven by a person. Everything else goes straight on.
import { describe, expect, it, vi } from "vitest";
import { MOVE_PROMPT, offerMove, offersMove, type MoveGate, type MovePrompt } from "../src/move.js";

const OUTSIDE: MoveGate = { platform: "darwin", packaged: true, inApplications: false, driven: false };

function io(overrides: { ask?: () => Promise<number>; move?: () => boolean } = {}) {
  const warnings: string[] = [];
  const answer = overrides.ask ?? ((): Promise<number> => Promise.resolve(MOVE_PROMPT.defaultId));
  return {
    ask: vi.fn((_prompt: MovePrompt) => answer()),
    move: vi.fn(overrides.move ?? (() => true)),
    warn: (line: string) => warnings.push(line),
    warnings,
  };
}

describe("who is offered the move to Applications", () => {
  it("is a packaged mac bundle running from anywhere else", () => {
    expect(offersMove(OUTSIDE)).toBe(true);
  });

  it("is not one already in Applications, so a settled app never asks again", () => {
    expect(offersMove({ ...OUTSIDE, inApplications: true })).toBe(false);
  });

  it("is not an unpackaged run, which is a build tree in a checkout with nothing to move", () => {
    expect(offersMove({ ...OUTSIDE, packaged: false })).toBe(false);
  });

  it("is not linux or windows, where there is no Applications folder and no translocation", () => {
    expect(offersMove({ ...OUTSIDE, platform: "linux" })).toBe(false);
    expect(offersMove({ ...OUTSIDE, platform: "win32" })).toBe(false);
  });

  it("is never the smoke's launch, which runs the bundle out of dist with nobody to press a button", () => {
    expect(offersMove({ ...OUTSIDE, driven: true })).toBe(false);
  });
});

describe("the offer itself", () => {
  it("asks once, moves on the first button, and leaves the caller nothing to do", async () => {
    const deps = io();
    expect(await offerMove(OUTSIDE, deps)).toBe("moving");
    expect(deps.ask).toHaveBeenCalledTimes(1);
    expect(deps.ask.mock.calls[0]?.[0]).toBe(MOVE_PROMPT);
    expect(MOVE_PROMPT.buttons[MOVE_PROMPT.defaultId]).toBe("Move to Applications");
    expect(MOVE_PROMPT.buttons[MOVE_PROMPT.cancelId]).toBe("Not now");
    expect(deps.move).toHaveBeenCalledTimes(1);
    expect(deps.warnings).toEqual([]);
  });

  it("moves nothing when the other button is pressed", async () => {
    const deps = io({ ask: () => Promise.resolve(MOVE_PROMPT.cancelId) });
    expect(await offerMove(OUTSIDE, deps)).toBe("declined");
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("asks nobody when the launch is not one that is offered", async () => {
    const deps = io();
    expect(await offerMove({ ...OUTSIDE, inApplications: true }, deps)).toBe("not offered");
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("keeps the app running and says so when the move is refused or throws", async () => {
    const refused = io({ move: () => false });
    expect(await offerMove(OUTSIDE, refused)).toBe("failed");
    expect(refused.warnings).toEqual(["wsp could not move itself to Applications; it keeps running where it is"]);
    const threw = io({
      move: () => {
        throw new Error("Applications is not writable");
      },
    });
    expect(await offerMove(OUTSIDE, threw)).toBe("failed");
    expect(threw.warnings).toEqual(["wsp could not move itself to Applications: Applications is not writable"]);
  });

  it("says what it is asking in plain words, with no em-dash", () => {
    for (const line of [MOVE_PROMPT.message, MOVE_PROMPT.detail, ...MOVE_PROMPT.buttons]) {
      expect(line).not.toContain("—");
      expect(line).not.toContain("–");
    }
    expect(MOVE_PROMPT.detail).toContain("wsp command");
  });
});
