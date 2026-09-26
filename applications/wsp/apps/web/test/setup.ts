// SPDX-License-Identifier: AGPL-3.0-only
// jsdom gaps the terminal surface needs filled. The renderer paints through a
// Canvas 2D context and sizes the grid from measureText, so the stub answers
// with finite metrics; ResizeObserver, document.fonts and FontFace do not
// exist in jsdom; matchMedia drives DPR and reduced-motion tracking. The
// libghostty wasm arrives through Vite ?url imports, which resolve to served
// paths here, so fetch reads those two vendored files from disk instead.
import { configure } from "@testing-library/react";
import { beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// What every findBy and waitFor in these files is given to see the DOM settle. The library's own default is one
// second, which is the case budget's reasoning ignored: a gate at load average 135 stretches cases of 0.05 to 0.2 s
// to 5 to 8 s (the note on testTimeout in apps/web/vite.config.ts), and this file measured 3.3 s idle against 9.9 s
// under a parallel run of its own project alone. A findBy that ran out at one second in a landing gate reported the
// element as missing and printed the body, which reads as a fault in the app rather than as the machine being busy.
// Five seconds is a quarter of the case budget, so a wait that is really never going to land still fails well
// inside its case.
configure({ asyncUtilTimeout: 5_000 });

const metrics = { width: 8, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 };
const ctx2d = new Proxy({} as Record<string | symbol, unknown>, {
  get(target, key) {
    if (key in target) return target[key];
    if (key === "measureText") return () => metrics;
    if (key === "getImageData") return () => ({ data: [0, 0, 0, 255] });
    return () => undefined;
  },
  set(target, key, value) {
    target[key] = value;
    return true;
  },
});
HTMLCanvasElement.prototype.getContext = ((type: string) =>
  type === "2d" ? (ctx2d as unknown as CanvasRenderingContext2D) : null) as typeof HTMLCanvasElement.prototype.getContext;

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Base UI's scroll area calls getAnimations on its viewport; with the stub in
// place Base UI would also wait for animations before unmounting a dialog, so
// its own switch keeps that path synchronous, as it is with no getAnimations.
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
  (globalThis as { BASE_UI_ANIMATIONS_DISABLED?: boolean }).BASE_UI_ANIMATIONS_DISABLED = true;
}

// jsdom has no top layer, so no element is ever :modal or :popover-open. Its selector engine, nwsapi, answers :modal
// by falling back to a :fullscreen check that re-enters the engine for the same node, so one :modal match on a large
// document costs millions of :fullscreen matches (measured: 104 million for one menu opening inside a 1,100-element
// dialog, 14 s idle and past the 20 s budget under load). Floating UI asks :modal of every ancestor on every position
// computation, so the two top-layer pseudo-classes answer false here without touching the engine.
if (typeof Element !== "undefined") {
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return selectors === ":modal" || selectors === ":popover-open" ? false : matches.call(this, selectors);
  };
}

if (typeof ResizeObserver === "undefined") {
  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = InertResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof document !== "undefined" && !("fonts" in document)) {
  Object.defineProperty(document, "fonts", {
    value: {
      add: () => {},
      load: async () => [],
      check: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

if (typeof FontFace === "undefined") {
  class InertFontFace {
    async load(): Promise<this> {
      return this;
    }
  }
  globalThis.FontFace = InertFontFace as unknown as typeof FontFace;
}

// jsdom's URL resolves relative references against the page origin, so the path is built with node:path.
const vendorDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/terminal/ghostty/vendor");
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const wasm = /\/([^/?#]+\.wasm)(?:[?#].*)?$/.exec(url);
  if (wasm) {
    const bytes = readFileSync(resolve(vendorDir, wasm[1]!));
    return Promise.resolve(new Response(bytes, { headers: { "content-type": "application/wasm" } }));
  }
  return realFetch(input, init);
}) as typeof fetch;

// The kit's sidebar persists its open state through the Cookie Store API,
// which jsdom does not ship; toggling it in a test needs a sink.
(globalThis as { cookieStore?: unknown }).cookieStore ??= { set: async () => {} };

// jsdom has no CSS.escape or scrollIntoView; the composer's slash menu uses both to keep the active row in view.
if (typeof globalThis.CSS === "undefined") {
  (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value.replace(/[^\w-]/g, ch => `\\${ch}`) };
}
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom's Range has no geometry; the editor measures the caret's range to keep it scrolled into view.
if (typeof Range !== "undefined" && typeof Range.prototype.getBoundingClientRect !== "function") {
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = empty;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
}

// jsdom has no ClipboardEvent; the editor's paste path checks the event's class name before reading clipboardData.
if (typeof globalThis.ClipboardEvent === "undefined") {
  class ClipboardEvent extends Event {
    readonly clipboardData: DataTransfer | null;
    constructor(type: string, init?: ClipboardEventInit) {
      super(type, init);
      this.clipboardData = init?.clipboardData ?? null;
    }
  }
  (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent = ClipboardEvent;
  (window as unknown as { ClipboardEvent?: unknown }).ClipboardEvent = ClipboardEvent;
}

// jsdom has no PointerEvent, and the checkbox and radio primitives re-dispatch a click as one; without it every
// tick in a test throws inside the primitive. One home for it, since every case that ticks a box needs it.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEvent extends MouseEvent {}
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEvent;
  (window as unknown as { PointerEvent?: unknown }).PointerEvent = PointerEvent;
}

// The app records what a person is reading in the page's address, so a case that opened a thread leaves one behind
// and the next case would open on it. Every case starts on a page with no address, as a first visit does.
beforeEach(() => {
  if (typeof window !== "undefined") window.location.hash = "";
});

// jsdom's CSS parser does not know @layer, and the file tree writes a stylesheet that opens with one on every
// render, so a run printed a parse error per render that reads as a fault in the app. Only that kind of error is
// dropped here; every other thing jsdom reports still reaches the run. _virtualConsole is jsdom's own private
// field, so a jsdom that moves it leaves this filter doing nothing and the case below goes red, which is the
// failure to want.
type JsdomErrorReporters = {
  listeners(event: "jsdomError"): ((error: unknown) => void)[];
  removeAllListeners(event: "jsdomError"): void;
  on(event: "jsdomError", listener: (error: unknown) => void): void;
};
const jsdomErrors = (window as unknown as { _virtualConsole?: JsdomErrorReporters })._virtualConsole;
if (jsdomErrors) {
  const reporters = jsdomErrors.listeners("jsdomError");
  jsdomErrors.removeAllListeners("jsdomError");
  jsdomErrors.on("jsdomError", error => {
    if ((error as { type?: string }).type === "css parsing") return;
    for (const report of reporters) report(error);
  });
}
