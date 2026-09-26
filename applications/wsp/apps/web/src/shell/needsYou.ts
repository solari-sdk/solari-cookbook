// SPDX-License-Identifier: AGPL-3.0-only
// How a need, a prompt or a machine that came up is said outside the app. Which
// road that takes belongs to the shell, so there is one road per shell and the
// app picks by which one holds: the desktop shell owns its window's focus, so
// the page hands it the sentence and it decides whether to show anything; a
// browser tab has the browser's own notifications, asked for on the press that
// opens the setup and spoken only while the tab is hidden. Nothing is said
// while the app is in front of the person, and nothing makes a sound.
import { NEEDS_YOU, type InitNeedsYou } from "@wsp/protocol";
import { desktopBridge } from "../lib/desktopShell.js";

/** Whether the shell holding this page owns its own notifications: the one reading of which road speaks, so the
 * browser's own leave is neither asked for nor needed there. */
const shellOwnsNotices = (): boolean => desktopBridge()?.needsYou !== undefined;

/** Leave to notify, asked at most once a page and only where the browser owns the notifications. It rides a press
 * rather than an event on purpose: Safari ignores a request made outside a gesture and the others quieten it to a
 * prompt most people never see, so the ask goes out as a build starts, which a press on the Image card's Build began.
 * A shell with its own notifications needs no leave. */
let asked = false;
export function askToNotify(): void {
  if (asked || shellOwnsNotices() || typeof Notification === "undefined" || Notification.permission !== "default") return;
  asked = true;
  void Notification.requestPermission();
}

/** Test isolation: forget that this page has asked. */
export function resetAskedToNotify(): void {
  asked = false;
}

/** How one shell tells the person outside the app. */
export interface NeedsYouRoad {
  /** Asks for whatever the road needs before it can speak; nothing on a shell that needs no leave. */
  ready(): void;
  /** Says the need outside the app, or nothing while the app already has the person's eyes. */
  say(need: InitNeedsYou): void;
  /** Drops the listener for a click on whatever this road showed, and anything it left standing. */
  close(): void;
}

/** The desktop shell's road: the need goes over the bridge and the shell decides on its own window's focus, since a
 * page cannot read it. A click there raises the window and the page opens the build. */
function desktopRoad(onOpen: () => void): NeedsYouRoad {
  const bridge = desktopBridge()!;
  const off = bridge.onNeedsYouOpen?.(onOpen);
  return {
    ready: () => {},
    say: need => bridge.needsYou?.(need),
    close: () => off?.(),
  };
}

/** A browser tab's road: the browser's own notifications, asked for once and spoken only while the tab is hidden. */
function browserRoad(onOpen: () => void): NeedsYouRoad {
  const standing = new Set<Notification>();
  const has = (): boolean => typeof Notification !== "undefined";
  return {
    ready: askToNotify,
    say: need => {
      if (!has() || Notification.permission !== "granted" || !document.hidden) return;
      const shown = new Notification(NEEDS_YOU, { body: need.what, silent: true });
      standing.add(shown);
      shown.onclick = () => {
        window.focus();
        shown.close();
        standing.delete(shown);
        onOpen();
      };
    },
    close: () => {
      for (const shown of standing) shown.close();
      standing.clear();
    },
  };
}

/** One entry per shell: which one holds this page, and the road it gives. Adding a shell adds a row here and its
 * road above, and nothing else reads which shell is running. */
const ROADS: readonly { holds(): boolean; road(onOpen: () => void): NeedsYouRoad }[] = [
  { holds: shellOwnsNotices, road: desktopRoad },
  { holds: () => true, road: browserRoad },
];

export const needsYouRoad = (onOpen: () => void): NeedsYouRoad => ROADS.find(r => r.holds())!.road(onOpen);
