// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in stage over a scripted daemon link: a copied login is recorded as
// copied and nothing runs for it; a machine sign-in is judged by its exit code.
// The machine sign-in with a fake shim: the page the tool asks to open, when it
// names a callback port, is what o opens, whichever order it and the printed
// link arrive in.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import { describe, expect, it } from "vitest";
import { flowHooks, settledOutcomes, signInStage, stageLogins, type SignInFlow, type SignInStageOptions } from "../src/init-signin.js";
import { vaultRows } from "../src/init-vault.js";
import { fakePtyLink, type FakePty, type FakePtyLink } from "./fake-pty-link.js";
import { loginOf } from "./signin-questions.js";

const CODEX: ManifestEntry = { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: [], bytes: 0, default: "bring", choice: "copy" };
const GH: ManifestEntry = { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "copy" };

function stage(link: FakePtyLink, over: Partial<SignInStageOptions> & { tty?: boolean } = {}) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), over.tty === true ? { isTTY: true, columns: 120 } : {});
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const run = signInStage({
    logins: [CODEX],
    dial: async () => ({ link: link.dial(), close: () => {} }),
    terminal: { input, output },
    open: async () => true,
    flow: { armed: false },
    ...over,
  });
  return { run, input, text: () => stripVTControlCharacters(chunks.join("")) };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));
const PRINTED = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
const PAGE = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A42485%2Fcallback";
const DEVICE = "https://github.com/login/device";
const BUILDER = { id: "m_builder", name: "default" };

/** A machine sign-in over the stage's hooks. The shim is what the host relay does with a browser.open from the
 * builder: asks autoOpen (with the port when the page names one), opens or logs the line through onLine. The tool
 * asks for its page before it prints the link, or after, or never, as the order says. */
function signInOnTheMachine(order: "before" | "after" | "never") {
  const link = fakePtyLink();
  const flow: SignInFlow = { armed: false };
  const hooks = flowHooks(flow, BUILDER);
  const opened: string[] = [];
  const lines: string[] = [];
  const shim = (url: string, port?: number): void => {
    if (hooks.autoOpen(BUILDER.id, url, port)) {
      opened.push(url);
      return;
    }
    const line = hooks.openLine("default (builder)", new URL(url).host, url);
    if (!hooks.onLine(line)) lines.push(line);
  };
  let pty: FakePty | undefined;
  link.script = (p, line) => {
    if (line !== `printf '\\036'; exec bash -c ${loginOf("codex")}`) return;
    pty = p;
    if (order === "before") shim(PAGE, 42485);
    link.data(p, `Opening browser to sign in...\r\nIf the browser didn't open, visit: ${PRINTED}\r\nPaste code here if prompted > `);
  };
  const st = stage(link, { logins: [{ ...CODEX, choice: "machine" }], open: async u => (opened.push(u), true), flow });
  const ready = async (): Promise<FakePty> => {
    for (let i = 0; i < 100 && pty === undefined; i++) await tick();
    if (pty === undefined) throw new Error("the sign-in never ran");
    return pty;
  };
  const press = async (key: string): Promise<void> => {
    st.input.write(key);
    await tick();
  };
  return { ...st, link, flow, shim, opened, lines, ready, press };
}

describe("the sign-in stage", () => {
  it("a copied login is recorded as copied: nothing runs on the machine for it and nothing is offered", async () => {
    const link = fakePtyLink();
    const st = stage(link, { logins: [GH, CODEX], skipWhy: "nobody here" });
    const rows = await st.run;
    expect(rows).toEqual([
      { id: "logins/gh", label: "GitHub CLI login", state: "copied" },
      { id: "logins/codex", label: "Codex login", state: "copied" },
    ]);
    expect(link.ptys).toEqual([]);
    expect(st.text()).toContain("GitHub CLI login: copied");
    expect(st.text()).not.toMatch(/checking:|r retry|s skip/);
  });

  it("a sign-in on the machine that exits 0 is signed in by that exit: no status check follows, the next row comes at once, and nothing is offered", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("; exec bash -c ")) link.exit(pty, 0);
    };
    const st = stage(link, { logins: [{ ...CODEX, choice: "machine" }, { ...GH, choice: "machine" }] });
    const rows = await st.run;
    expect(link.ptys.map(p => p.ran)).toEqual([loginOf("codex"), loginOf("gh")]);
    expect(rows).toEqual([
      { id: "logins/codex", label: "Codex login", state: "signed-in", command: loginOf("codex"), exit: 0, note: `${loginOf("codex")} exited 0` },
      { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", command: loginOf("gh"), exit: 0, note: `${loginOf("gh")} exited 0` },
    ]);
    const text = st.text();
    const first = text.indexOf(`Codex login: signed in (${loginOf("codex")} exited 0)\n`);
    expect(first).toBeGreaterThan(-1);
    expect(text.slice(first)).toContain(`GitHub CLI login  ${loginOf("gh")}\n`);
    expect(text).not.toMatch(/r retry|s skip|checking:/);
  });

  it("a sign-in on the machine that exits with a failure is not signed in by that exit, and a retry or a skip is offered", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("; exec bash -c ")) link.exit(pty, 1);
    };
    const st = stage(link, { logins: [{ ...CODEX, choice: "machine" }] });
    for (let i = 0; i < 100 && !st.text().includes("r retry"); i++) await tick();
    expect(st.text()).toContain(`Codex login: not signed in (${loginOf("codex")} exited 1)`);
    st.input.write("s");
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "skipped", exit: 1, note: "skipped by you" });
  });
});

describe("o and the page the machine asks to open", () => {
  it("a page with a callback port that arrived before o is what o opens, through the forwarded port, and the line says it returns on its own", async () => {
    const t = signInOnTheMachine("before");
    const pty = await t.ready();
    expect(t.text()).toContain("default (builder): press o on the link above to open it here");
    expect(t.lines).toEqual([]);
    expect(t.flow.callbackUrl).toBe(PAGE);
    await t.press("o");
    expect(t.opened).toEqual([PAGE]);
    expect(t.text()).toContain("opened the sign-in page; it returns to the machine on its own");
    expect(t.text()).not.toContain("paste it into the terminal above");
    // o opened the machine's own page: nothing is armed, and the page asked for again is the one already open.
    expect(t.flow.armed).toBe(false);
    t.shim(PAGE, 42485);
    expect(t.opened).toEqual([PAGE]);
    expect(t.text()).toContain("default (builder): that page is already open here");
    expect(pty.writes.slice(1)).toEqual([]);
    t.link.exit(pty, 0);
    const [r] = await t.run;
    expect(r).toMatchObject({ state: "signed-in", exit: 0 });
    expect(t.flow).toEqual({ armed: false });
  });

  it("a page with a callback port that arrives after o opens on its own: o opened the printed link and asked for the code to be pasted", async () => {
    const t = signInOnTheMachine("after");
    const pty = await t.ready();
    await t.press("o");
    expect(t.opened).toEqual([PRINTED]);
    expect(t.text()).toContain("opened on this computer; if the page shows a code, paste it into the terminal above");
    expect(t.flow.armed).toBe(true);
    t.shim(PAGE, 42485);
    expect(t.opened).toEqual([PRINTED, PAGE]);
    expect(t.flow.armed).toBe(false);
    t.link.exit(pty, 0);
    await t.run;
  });

  it("with no page asked for, o opens the printed link and asks for the code to be pasted; a page without a port is not kept for o", async () => {
    const t = signInOnTheMachine("never");
    const pty = await t.ready();
    t.shim(DEVICE);
    expect(t.flow.callbackUrl).toBeUndefined();
    expect(t.text()).toContain("default (builder): press o on the link above to open it here");
    await t.press("o");
    expect(t.opened).toEqual([PRINTED]);
    expect(t.text()).toContain("opened on this computer; if the page shows a code, paste it into the terminal above");
    t.link.exit(pty, 0);
    await t.run;
  });

  it("a page that arrives with no pty on screen is left to the app and not kept for a later o", async () => {
    const t = signInOnTheMachine("never");
    t.shim(PAGE, 42485);
    expect(t.lines).toEqual(["default (builder): a sign-in page for claude.com is ready; open it from the app"]);
    expect(t.flow).toEqual({ armed: false });
    const pty = await t.ready();
    await t.press("o");
    expect(t.opened).toEqual([PRINTED]);
    t.link.exit(pty, 0);
    await t.run;
  });
});

describe("what an answer means at build time", () => {
  const login = (id: string, label: string): ManifestEntry => ({ rung: "logins", id, label, paths: [], bytes: 0, default: "skip" });
  const manifest = { entries: [login("logins/claude", "Claude Code login"), login("logins/codex", "Codex login"), login("logins/gh", "GitHub CLI login")] };

  it("a row answered API key or token is the vault step's, under the variable its tool reads, and never staged as a sign-in", () => {
    const choices = new Map([["logins/claude", "token"], ["logins/codex", "key"], ["logins/gh", "key"]]);
    // Claude Code mints a token here and Codex reads a key the catalog knows; the GitHub CLI has no key variable,
    // so nothing of it is the vault's.
    expect(vaultRows(manifest, choices).map(r => [r.entry.id, r.name])).toEqual([["logins/claude", "CLAUDE_CODE_OAUTH_TOKEN"], ["logins/codex", "OPENAI_API_KEY"]]);
    expect(vaultRows(manifest, new Map())).toEqual([]);
    // Neither answer is a sign-in to run there, so nothing of them is staged for the machine.
    expect(stageLogins(manifest, choices, new Set())).toEqual([]);
    expect(stageLogins(manifest, new Map([["logins/gh", "machine"]]), new Set()).map(e => e.id)).toEqual(["logins/gh"]);
  });

  it("a login carrying no answer at all is one the stage signs in, never one it settles where it stands", async () => {
    // Only an answer named in the table settles a row without running it; anything else, an absent answer included,
    // is the stage's to sign in. A row dropped here would leave the build silent about a login it never ran.
    const { choice: _none, ...BARE } = CODEX;
    const settled = settledOutcomes([BARE, { ...GH, choice: "later" }], undefined, new PassThrough());
    expect(settled.machine.map(([e]) => e.id)).toEqual(["logins/codex"]);
    expect(settled.outcomes.map(r => r.state)).toEqual(["skipped", "deferred"]);

    // And through the stage itself: the answerless row's own command runs on the machine.
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("; exec bash -c ")) link.exit(pty, 0);
    };
    const st = stage(link, { logins: [BARE] });
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "signed-in", exit: 0, command: loginOf("codex") });
    expect(link.ptys.map(p => p.ran)).toEqual([loginOf("codex")]);
  });
});
