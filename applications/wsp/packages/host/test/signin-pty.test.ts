// SPDX-License-Identifier: AGPL-3.0-only
// A sign-in's line run for real: the daemon binary this checkout ships opens
// the pty and an interactive bash takes the line, as on any computer. Every
// tool here is a stub script, the daemon starts with an emptied environment
// whose PATH holds none of them, and every home is a scratch folder.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Machine } from "@wsp/engine";
import { shellQuote, type AgentsSignInEvent } from "@wsp/protocol";
import type { AgentsOn } from "@wsp/runtime";
import { planSignIn, watchSignIn, type SignInPlan } from "../src/agents-signin.js";
import { daemonBinaryHere } from "../src/assets.js";
import { LocalDaemon } from "../src/local-daemon.js";
import { watchPty, type PtyLink } from "../src/signin-relay.js";

let root: string;
let stubs: string;
let daemon: LocalDaemon | undefined;
let link: PtyLink;
let close: () => void = () => {};

const stub = (name: string, body: string): void => {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "wsp-signin-pty-"));
  stubs = join(root, "stubs");
  mkdirSync(stubs);
  mkdirSync(join(root, "sbin"));
  mkdirSync(join(root, "daemon-home"));
  // Each tool says where it ran and with what into the login's home, on the login's PATH alone; runuser, on the
  // daemon's PATH as on a box, says whom it ran as and hands the rest of its line on.
  stub("claude", `pwd > "$HOME/claude-cwd"; printf '%s\\n' "$@" > "$HOME/claude-argv"; if [ "$CLAUDE_HANG" = 1 ]; then echo "Waiting for the page."; exec sleep 30; fi; if [ "$CLAUDE_FAIL" = 1 ]; then echo "Error: that page expired"; exit 1; fi; echo "Signed in to the server."; exit 0`);
  stub("../sbin/runuser", `echo "$2" > "${join(root, "runuser-as")}"; while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
  const wrapper = join(root, "daemon.sh");
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/env -i PATH=${shellQuote(join(root, "sbin"))}:/usr/bin:/bin HOME=${shellQuote(join(root, "daemon-home"))} ${shellQuote(daemonBinaryHere())} "$@"\n`);
  chmodSync(wrapper, 0o755);
  daemon = await LocalDaemon.start({ root, workFolder: root, rootsPath: join(root, "roots"), inboxDir: join(root, "inbox"), binary: wrapper, say: () => {} });
  const listeners = new Set<(e: Record<string, unknown>) => void>();
  const reach = daemon.link(e => listeners.forEach(fn => fn(e as unknown as Record<string, unknown>)));
  await reach.ready;
  close = () => reach.close();
  link = {
    op: (op, extra) => reach.request(op, extra),
    onEvent: fn => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}, 30_000);

afterAll(async () => {
  close();
  await daemon?.close();
  rmSync(root, { recursive: true, force: true });
});

/** A computer you joined, answering the one probe of who its lines run as in the shape a case names. */
function box(probe: { os: "Linux" | "Darwin"; uid: string; self: string; owner: string; runuser: boolean }, home: string, path: string): AgentsOn {
  const stdout = [probe.os, probe.uid, probe.self, probe.owner, probe.runuser ? "1" : "0", "/root", "/usr/bin", ""].join("\n");
  return { kind: "box", machine: { exec: async () => ({ exitCode: 0, stdout, stderr: "" }) } as unknown as Pick<Machine, "exec">, login: { HOME: home, PATH: path } };
}

const SHAPES = {
  "a root daemon handing the lines to the home's owner": { os: "Linux", uid: "0", self: "root", owner: "ada", runuser: true },
  "a root daemon whose home is root's own": { os: "Linux", uid: "0", self: "root", owner: "root", runuser: true },
  "a daemon that is not root": { os: "Linux", uid: "1000", self: "ada", owner: "ada", runuser: false },
  "a joined Mac": { os: "Darwin", uid: "501", self: "ada", owner: "ada", runuser: false },
} as const;

async function signIn(plan: SignInPlan, over: PtyLink = link): Promise<Omit<AgentsSignInEvent, "type" | "signInId">[]> {
  const steps: Omit<AgentsSignInEvent, "type" | "signInId">[] = [];
  await watchSignIn(plan, { link: over, emit: s => void steps.push(s), typing: () => {}, stop: new Promise<void>(() => {}) }, { capMs: 15_000, flushMs: 10 });
  return steps;
}

interface Staged {
  dir?: string;
  /** The folder's mode and each file's in it, the moment the typed line went in. */
  modes?: { dir: number; files: number[] };
  /** Whether the folder was still there when the tool first spoke. */
  whileRunning?: boolean;
}

/** The daemon link with the file a command was put in looked at: as its line is typed, and as the tool first speaks.
 * `swallow` drops the typed line, so the command never runs. */
function staging(o: { swallow?: boolean } = {}): { over: PtyLink; staged: Staged } {
  const staged: Staged = {};
  const over: PtyLink = {
    onEvent: fn =>
      link.onEvent(e => {
        if (e["type"] === "pty.data" && staged.dir !== undefined && staged.whileRunning === undefined && String(e["data"]).includes("Waiting for the page.")) staged.whileRunning = existsSync(staged.dir);
        fn(e);
      }),
    op: async (op, extra) => {
      if (op === "pty.write" && staged.dir !== undefined && staged.modes === undefined && String(extra?.["data"]).includes(staged.dir)) {
        const dir = staged.dir;
        staged.modes = { dir: statSync(dir).mode & 0o777, files: readdirSync(dir).map(f => statSync(join(dir, f)).mode & 0o777) };
        if (o.swallow === true) return { ok: true };
      }
      const reply = await link.op(op, extra);
      if (op === "exec" && extra?.["stdin"] !== undefined) staged.dir = String(reply["stdout"]).trim();
      return reply;
    },
  };
  return { over, staged };
}

const freshHome = (name: string): string => {
  const home = join(root, name.replace(/\W+/g, "-"));
  mkdirSync(home);
  return home;
};

describe("a sign-in line on every kind of computer", () => {
  for (const [shape, probe] of Object.entries(SHAPES)) {
    it(`${shape}: the tool runs on the login's PATH, in its home, and the pty ends with it`, async () => {
      const home = freshHome(shape);
      const plan = await planSignIn(box(probe, home, `${stubs}:/usr/bin:/bin`), { agent: "claude", server: "notion" });
      const steps = await signIn(plan);
      expect(steps.at(-1)).toEqual({ state: "signed-in" });
      expect(readFileSync(join(home, "claude-argv"), "utf8")).toBe("mcp\nlogin\nnotion\n--no-browser\n");
      expect(readFileSync(join(home, "claude-cwd"), "utf8").trim()).toBe(home);
      if (probe.owner !== probe.self) expect(readFileSync(join(root, "runuser-as"), "utf8").trim()).toBe(probe.owner);
    }, 20_000);
  }

  it("says the tool's own last words, never the pty's echo of a line that wrapped past the pty's width", async () => {
    const home = freshHome("wrapped");
    const long = Array.from({ length: 30 }, (_, i) => `/opt/nowhere-${i}/bin`).join(":");
    const on = box(SHAPES["a root daemon handing the lines to the home's owner"], home, `${long}:${stubs}:/usr/bin:/bin`);
    const plan = await planSignIn(on, { agent: "claude", server: "notion" });
    expect(plan.line.command.length).toBeGreaterThan(400);
    const steps = await signIn({ ...plan, line: { ...plan.line, command: `CLAUDE_FAIL=1 ${plan.line.command}` } });
    expect(steps.at(-1)).toEqual({ state: "failed", said: "Error: that page expired" });
  }, 20_000);

  it("says the shell's own words for a tool that is not on the login's PATH, not the word exit", async () => {
    const home = freshHome("missing");
    const plan = await planSignIn(box(SHAPES["a daemon that is not root"], home, "/usr/bin:/bin"), { agent: "claude", server: "notion" });
    const steps = await signIn(plan);
    expect(steps.at(-1)).toMatchObject({ state: "failed", said: expect.stringMatching(/claude: command not found/) });
  }, 20_000);
});

describe("a name holding control characters", () => {
  it("reaches the tool as data: Ctrl-U erases nothing typed and the command after it never runs", async () => {
    const home = freshHome("injected");
    const marker = join(root, "marker");
    const name = `notion\x15echo INJECTED > ${marker}; #`;
    const outcome = await watchPty({ link, command: `HOME=${shellQuote(home)} PATH=${shellQuote(`${stubs}:/usr/bin:/bin`)} claude mcp login ${shellQuote(name)} --no-browser`, timeoutMs: 15_000, flushMs: 10 });
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(home, "claude-argv"), "utf8")).toBe(`mcp\nlogin\n${name}\n--no-browser\n`);
  }, 20_000);
});

describe("a command longer than the terminal takes as one typed line", () => {
  it("on a joined Mac with a PATH over the 1024 bytes a canonical tty line holds, the tool still runs from a file only the login reads", async () => {
    const home = freshHome("long-path");
    const long = Array.from({ length: 260 }, (_, i) => `/opt/nowhere-${i}/bin`).join(":");
    const plan = await planSignIn(box(SHAPES["a joined Mac"], home, `${long}:${stubs}:/usr/bin:/bin`), { agent: "claude", server: "notion" });
    expect(plan.line.command.length).toBeGreaterThan(4096);
    const { over, staged } = staging();
    const steps = await signIn(plan, over);
    expect(steps.at(-1)).toEqual({ state: "signed-in" });
    expect(readFileSync(join(home, "claude-argv"), "utf8")).toBe("mcp\nlogin\nnotion\n--no-browser\n");
    expect(staged.modes).toEqual({ dir: 0o700, files: [0o600] });
    expect(existsSync(staged.dir!)).toBe(false);
  }, 30_000);

  it("the file is gone before the tool runs, and gone when a sign-in is stopped before its line ever ran", async () => {
    const home = freshHome("staged-gone");
    const running = staging();
    const hung = await watchPty({ link: running.over, command: `CLAUDE_HANG=1 HOME=${shellQuote(home)} PATH=${shellQuote(`${stubs}:/usr/bin:/bin`)} claude mcp login notion`, timeoutMs: 15_000, flushMs: 10, stop: new Promise(r => setTimeout(r, 1_500)) });
    expect(hung.stopped).toBe(true);
    expect(running.staged.whileRunning).toBe(false);
    const never = staging({ swallow: true });
    const stopped = await watchPty({ link: never.over, command: "echo never", timeoutMs: 15_000, flushMs: 10, stop: new Promise(r => setTimeout(r, 300)) });
    expect(stopped.stopped).toBe(true);
    expect(never.staged.modes).toEqual({ dir: 0o700, files: [0o600] });
    expect(existsSync(never.staged.dir!)).toBe(false);
  }, 30_000);
});

describe("what the pages and codes are read from", () => {
  it("never shows a server named like a page, nor anything the shell printed before the tool, as the sign-in page", async () => {
    const home = freshHome("evil-name");
    const plan = await planSignIn(box(SHAPES["a joined Mac"], home, `${stubs}:/usr/bin:/bin`), { agent: "claude", server: "https://evil.example/login" });
    const steps = await signIn({ ...plan, line: { ...plan.line, command: `export CLAUDE_FAIL=1; ${plan.line.command}` } });
    expect(steps.filter(s => s.state === "waiting")).toEqual([]);
    expect(steps.at(-1)).toEqual({ state: "failed", said: "Error: that page expired" });
  }, 20_000);
});
