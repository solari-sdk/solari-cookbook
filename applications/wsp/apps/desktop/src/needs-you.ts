// SPDX-License-Identifier: AGPL-3.0-only
// The system notification the shell shows when a build waits on the person, or
// a machine of theirs came up, and this window is not the one they are looking
// at. The page cannot read its own window's focus, so it hands the sentence
// over and the decision is made here: a focused window says nothing, since the
// sidebar's row, the toast and the title already do. A click raises the window
// and tells the page to open whatever was spoken about. No sound: neither a
// build waiting nor a machine coming up is an alarm.
import { NEEDS_YOU, type InitNeedsYou } from "@wsp/protocol";

/** The part of Electron's Notification this needs; a fake stands in for it under test. */
export interface SystemNotification {
  show(): void;
  on(event: "click", listener: () => void): void;
}

/** What the shell builds one from, and whether this computer can show one at all. */
export interface Notifier {
  supported(): boolean;
  make(o: { title: string; body: string; silent: boolean }): SystemNotification;
}

/** The window a need is spoken for: whether the person is looking at it, how it is raised, and how the page on it is
 * told a click landed so it opens the build. */
export interface NoticeWindow {
  focused(): boolean;
  raise(): void;
  open(): void;
}

/** Shows the need over the system, or nothing when the person is already looking at the window it belongs to or this
 * computer shows no notifications. True where one was shown, which is what a test reads. */
export function sayNeedsYou(need: InitNeedsYou, win: NoticeWindow, notifier: Notifier): boolean {
  if (win.focused() || !notifier.supported()) return false;
  const shown = notifier.make({ title: NEEDS_YOU, body: need.what, silent: true });
  shown.on("click", () => {
    win.raise();
    win.open();
  });
  shown.show();
  return true;
}
