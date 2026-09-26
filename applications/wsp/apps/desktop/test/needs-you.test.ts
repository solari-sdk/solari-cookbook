// SPDX-License-Identifier: AGPL-3.0-only
// The shell's road out of the app when a build waits on the person, against a
// stubbed Notification: a window the person is looking at says nothing, one
// they are not says the need's own sentence with no sound, and a click raises
// the window and tells its page to open the build.
import { NEEDS_YOU } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { sayNeedsYou, type Notifier, type SystemNotification } from "../src/needs-you.js";

const NEED = { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 };

/** A Notification that records what it was built with and what it did, and hands its click back to the test. */
function stub(supported = true) {
  const shown: { title: string; body: string; silent: boolean }[] = [];
  const clicks: (() => void)[] = [];
  let displayed = 0;
  const notifier: Notifier = {
    supported: () => supported,
    make: o => {
      shown.push(o);
      const note: SystemNotification = {
        show: () => {
          displayed += 1;
        },
        on: (_event, listener) => clicks.push(listener),
      };
      return note;
    },
  };
  return { notifier, shown, clicks, displayed: () => displayed };
}

function fakeWindow(focused: boolean) {
  const did: string[] = [];
  return { did, win: { focused: () => focused, raise: () => did.push("raise"), open: () => did.push("open") } };
}

describe("the shell's system notification for a build that needs the person", () => {
  it("says the need with the app's name, the need's own sentence and no sound, once the window has lost focus", () => {
    const { notifier, shown, displayed } = stub();
    const { win } = fakeWindow(false);
    expect(sayNeedsYou(NEED, win, notifier)).toBe(true);
    expect(shown).toEqual([{ title: NEEDS_YOU, body: "sign in to GitHub CLI login", silent: true }]);
    expect(displayed()).toBe(1);
  });

  it("says nothing while the window is the one the person is looking at: the row, the toast and the title already do", () => {
    const { notifier, shown, displayed } = stub();
    const { win, did } = fakeWindow(true);
    expect(sayNeedsYou(NEED, win, notifier)).toBe(false);
    expect(shown).toEqual([]);
    expect(displayed()).toBe(0);
    expect(did).toEqual([]);
  });

  it("a click raises the window and tells its page to open the build screen", () => {
    const { notifier, clicks } = stub();
    const { win, did } = fakeWindow(false);
    sayNeedsYou(NEED, win, notifier);
    expect(clicks).toHaveLength(1);
    expect(did).toEqual([]);
    clicks[0]!();
    expect(did).toEqual(["raise", "open"]);
  });

  it("a computer that shows no notifications is told nothing and builds none", () => {
    const { notifier, shown } = stub(false);
    const { win } = fakeWindow(false);
    expect(sayNeedsYou(NEED, win, notifier)).toBe(false);
    expect(shown).toEqual([]);
  });
});
