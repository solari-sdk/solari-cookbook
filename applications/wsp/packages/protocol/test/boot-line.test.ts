// SPDX-License-Identifier: AGPL-3.0-only
// The page's one inline script, written by the host and read back by the
// desktop shell: one expression, so what the host writes is what a reader
// finds and nothing else on a page is mistaken for it.
import { describe, expect, it } from "vitest";
import { BOOT_SCRIPT, bootLineOf, type BootPayload } from "../src/index.js";

/** The page as the host serves it: the boot object inlined into the one script element. */
const served = (boot: BootPayload): string =>
  `<!doctype html><html><head></head><body><div id="root"></div><script>window.__WSP__ = ${JSON.stringify(boot)};</script></body></html>`;

describe("bootLineOf", () => {
  it("reads the object off a page the host served, on loopback and beyond it", () => {
    const here: BootPayload = { wsPort: 4410, tokenHash: "a".repeat(64), wsPath: "/ws", paired: true, version: "0.2.0", statePath: "/Users/me/.wsp/state.json" };
    expect(bootLineOf(served(here))).toEqual(here);
    const away: BootPayload = { wsPath: "/ws", paired: false, version: "0.2.0" };
    expect(bootLineOf(served(away))).toEqual(away);
  });

  it("answers nothing for a page with no such line, a broken one, or the default the web app ships", () => {
    expect(bootLineOf("<!doctype html><html><body>hello</body></html>")).toBeUndefined();
    expect(bootLineOf("<script>window.__WSP__ = {not json};</script>")).toBeUndefined();
    expect(bootLineOf("<script>window.__WSP__ = {};</script>")).toBeUndefined();
    expect(bootLineOf("<script>window.__WSP__ = null;</script>")).toBeUndefined();
    // What apps/web/index.html carries before a host swaps it, which no host served.
    expect(bootLineOf(`<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`)).toBeUndefined();
  });

  it("is the expression the host replaces, so the line it writes is the line a reader finds", () => {
    const html = `<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`;
    expect(BOOT_SCRIPT.test(html)).toBe(true);
    const boot: BootPayload = { wsPath: "/ws", paired: true, version: "0.2.0", tokenHash: "a".repeat(64) };
    expect(bootLineOf(html.replace(BOOT_SCRIPT, () => `<script>window.__WSP__ = ${JSON.stringify(boot)};</script>`))).toEqual(boot);
  });
});
