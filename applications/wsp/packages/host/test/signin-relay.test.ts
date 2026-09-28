// SPDX-License-Identifier: AGPL-3.0-only
// The pty relay against a scripted link: bytes both ways, raw mode set and
// restored, size propagated, a printed URL shown once as a hyperlink and
// opened here on o, the quiet status run reading only what sits between the
// echo and the exit marker.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { Question } from "@wsp/catalog";
import { OFFER_MS, QuestionScanner, UrlScanner, hyperlink, relayPty, runQuiet, shellLine, stripOsc8, urlsIn, watchPty, type Asked, type RelayTerminal } from "../src/signin-relay.js";
import { fakePtyLink, type FakePty } from "./fake-pty-link.js";
import { ASKED } from "./signin-questions.js";

interface Term extends RelayTerminal {
  input: PassThrough & RelayTerminal["input"];
  text(): string;
  raw: boolean[];
  columns: number;
  rows: number;
}

function terminal(tty = true): Term {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (on: boolean) => void };
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const raw: boolean[] = [];
  if (tty) {
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (on: boolean) => {
      raw.push(on);
      input.isRaw = on;
    };
  }
  output.columns = 120;
  output.rows = 40;
  return {
    input,
    output,
    text: () => chunks.join(""),
    raw,
    get columns() {
      return output.columns!;
    },
    set columns(v: number) {
      output.columns = v;
    },
    get rows() {
      return output.rows!;
    },
    set rows(v: number) {
      output.rows = v;
    },
  };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));

async function firstPty(link: ReturnType<typeof fakePtyLink>): Promise<FakePty> {
  for (let i = 0; i < 100 && link.ptys.length === 0; i++) await tick();
  const pty = link.ptys[0];
  if (!pty) throw new Error("no pty was created");
  return pty;
}

describe("URL detection", () => {
  it("strips OSC 8 wrappers, drops trailing punctuation and leaves a match that runs to the chunk's end for the next chunk", () => {
    const wrapped = "visit \x1b]8;;https://example.com/a?x=1\x1b\\https://example.com/a?x=1\x1b]8;;\x1b\\ now";
    expect(stripOsc8(wrapped)).toBe("visit https://example.com/a?x=1 now");
    expect(urlsIn(wrapped)).toEqual(["https://example.com/a?x=1"]);
    expect(urlsIn("Open this URL (https://github.com/login/device).\r\n")).toEqual(["https://github.com/login/device"]);
    expect(urlsIn("Open https://github.com/login/dev")).toEqual([]);
    expect(urlsIn("http://localhost:8976/oauth/callback and https://example.com/a and https://example.com/a again")).toEqual(["http://localhost:8976/oauth/callback", "https://example.com/a"]);
  });

  it("reports a URL split across chunks exactly once, and the same URL printed again not at all", () => {
    const s = new UrlScanner();
    expect(s.feed("Press Enter to open https://github.com/lo")).toEqual([]);
    expect(s.feed("gin/device in your browser...\r\n")).toEqual(["https://github.com/login/device"]);
    expect(s.feed("Open this URL to continue: https://github.com/login/device\r\n")).toEqual([]);
    expect(s.feed("\x1b]8;;https://claude.com/x\x07https://claude.com/x\x1b]8;;\x07\r\n")).toEqual(["https://claude.com/x"]);
  });

  it("flush settles a URL that ended the last chunk, once", () => {
    const s = new UrlScanner();
    expect(s.feed("Open https://x.test/abc")).toEqual([]);
    expect(s.flush()).toEqual(["https://x.test/abc"]);
    expect(s.flush()).toEqual([]);
    expect(s.feed("\r\n")).toEqual([]);
  });

  it("renders a terminal hyperlink", () => {
    expect(hyperlink("https://a.b/c")).toBe("\x1b]8;;https://a.b/c\x1b\\https://a.b/c\x1b]8;;\x1b\\");
  });

  it("types a short line that reads the staged command, removes its folder, then marks the tool starting and exec's it", () => {
    expect(shellLine({ dir: "/tmp/wsp-line.ab12", file: "'/tmp/wsp-line.ab12/line'" })).toBe(`c=$(< '/tmp/wsp-line.ab12/line'); rm -rf -- '/tmp/wsp-line.ab12'; printf '\\036'; exec bash -c "$c"\r`);
  });
});

describe("relayPty", () => {
  it("opens a pty at the terminal's size, runs the command, relays keystrokes up and bytes down, follows a resize, and restores the terminal", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    const run = relayPty({ link, command: "gh auth login", terminal: term, open: async u => (opened.push(u), true), timeoutMs: 60_000 });
    const pty = await firstPty(link);
    expect(pty.created).toEqual({ cols: 120, rows: 40, shell: "bash" });
    await tick();
    expect(pty.attached).toBe(true);
    expect(pty.ran).toBe("gh auth login");
    expect(term.raw).toEqual([true]);

    link.data(pty, "? Authenticate Git with your GitHub credentials? (Y/n) ");
    expect(term.text()).toContain("Authenticate Git");
    term.input.write("n");
    term.input.write("\r");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["n", "\r"]);

    term.columns = 100;
    term.rows = 30;
    term.output.emit("resize");
    await tick();
    expect(pty.resizes).toEqual([{ cols: 100, rows: 30 }]);

    link.exit(pty, 0);
    const outcome = await run;
    expect(outcome).toEqual({ exitCode: 0, timedOut: false, dropped: false, urls: 0, opened: 0 });
    expect(term.raw).toEqual([true, false]);
    expect(pty.killed).toBe(true);
    expect(term.input.listenerCount("data")).toBe(0);
    expect(term.output.listenerCount("resize")).toBe(0);
    expect(opened).toEqual([]);
  });

  it("shows a printed URL once as a hyperlink with the o offer; o opens it here, gives consent, and is not sent to the pty", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    let consented = 0;
    const run = relayPty({ link, command: "claude auth login", terminal: term, open: async u => (opened.push(u), true), onConsent: () => consented++, timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    const url = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
    link.data(pty, `If the browser didn't open, visit: \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\\r\nPaste code here if prompted > `);
    const shown = term.text();
    expect(shown).toContain(hyperlink(url));
    expect(shown).toContain("o opens it on this computer");
    expect(shown.split("o opens it on this computer")).toHaveLength(2);

    term.input.write("o");
    await tick();
    expect(opened).toEqual([url]);
    expect(consented).toBe(1);
    expect(pty.writes.slice(1)).toEqual([]);
    expect(stripVTControlCharacters(term.text())).toContain("opened on this computer");

    // The same URL printed again is not offered again. Enter keeps the offer (gh asks for one before it opens);
    // typing text ends it, so a later o is a keystroke.
    link.data(pty, `visit: ${url}\r\n`);
    expect(term.text().split("o opens it on this computer")).toHaveLength(2);
    term.input.write("\r");
    term.input.write("o");
    await tick();
    expect(opened).toEqual([url, url]);
    term.input.write("x");
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["\r", "x", "o"]);
    expect(opened).toEqual([url, url]);

    link.exit(pty, 0);
    const outcome = await run;
    expect(outcome).toEqual({ exitCode: 0, timedOut: false, dropped: false, urls: 1, opened: 2 });
  });

  it("offers only a page the tool printed: a link in the shell's banner is shown as text and never offered", async () => {
    const link = fakePtyLink();
    link.banner = "The default interactive shell is now zsh.\r\nFor more details, please visit https://support.apple.com/kb/HT208050.\r\n";
    const term = terminal();
    const run = relayPty({ link, command: "claude mcp login notion", terminal: term, open: async () => true, timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    link.data(pty, "Open https://claude.ai/oauth/authorize?x=1\r\n");
    expect(term.text()).toContain("https://support.apple.com/kb/HT208050");
    expect(term.text()).not.toContain(hyperlink("https://support.apple.com/kb/HT208050"));
    expect(term.text()).toContain(hyperlink("https://claude.ai/oauth/authorize?x=1"));
    link.exit(pty, 0);
    expect((await run).urls).toBe(1);
  });

  it("o opens the page the machine asked for when one arrived that returns through a forwarded port, and says so; without one, the printed link with the paste-code line", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    const consented: string[] = [];
    let page: string | undefined;
    const run = relayPty({ link, command: "claude auth login", terminal: term, open: async u => (opened.push(u), true), onConsent: u => consented.push(u), callbackUrl: () => page, timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    const printed = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
    link.data(pty, `If the browser didn't open, visit: ${printed}\r\nPaste code here if prompted > `);
    term.input.write("o");
    await tick();
    expect(opened).toEqual([printed]);
    expect(stripVTControlCharacters(term.text())).toContain("opened on this computer; if the page shows a code, paste it into the terminal above");

    page = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A42485%2Fcallback";
    term.input.write("o");
    await tick();
    expect(opened).toEqual([printed, page]);
    expect(consented).toEqual([printed, page]);
    expect(stripVTControlCharacters(term.text())).toContain("opened the sign-in page; it returns to the machine on its own");
    expect(pty.writes.slice(1)).toEqual([]);
    link.exit(pty, 0);
    expect((await run).opened).toBe(2);
  });

  it("arrow keys and other CSI sequences keep the o offer; typed text ends it", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    const run = relayPty({ link, command: "gh auth login", terminal: term, open: async u => (opened.push(u), true), timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    link.data(pty, "? Where do you use GitHub?  [Use arrows to move]\r\n> GitHub.com https://github.com/login/device \r\n");
    // CSI arrows, then the application-mode (DECCKM) arrows a tool that sets it makes the terminal send.
    term.input.write("\x1b[B");
    term.input.write("\x1b[A");
    term.input.write("\x1bOA");
    term.input.write("\x1bOB");
    term.input.write("\r");
    term.input.write("o");
    await tick();
    expect(opened).toEqual(["https://github.com/login/device"]);
    expect(pty.writes.slice(1)).toEqual(["\x1b[B", "\x1b[A", "\x1bOA", "\x1bOB", "\r"]);
    term.input.write("n");
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["\x1b[B", "\x1b[A", "\x1bOA", "\x1bOB", "\r", "n", "o"]);
    link.exit(pty, 0);
    await run;
  });

  it("a URL that ends the chunk is offered after a short quiet, so a tool that prints it and blocks still gets o", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const run = relayPty({ link, command: "netlify login", terminal: term, open: async () => true, timeoutMs: 60_000, flushMs: 20 });
    const pty = await firstPty(link);
    await tick();
    link.data(pty, "Opening https://app.netlify.com/authorize?ticket=abc");
    expect(term.text()).not.toContain("o opens it on this computer");
    await new Promise(r => setTimeout(r, 60));
    expect(term.text().split("o opens it on this computer")).toHaveLength(2);
    expect(term.text()).toContain(hyperlink("https://app.netlify.com/authorize?ticket=abc"));
    link.exit(pty, 0);
    expect((await run).urls).toBe(1);
  });

  it("an o pressed long after the URL appeared is a keystroke, and a failed open says so", async () => {
    const link = fakePtyLink();
    const term = terminal();
    let t = 1_000_000;
    const run = relayPty({ link, command: "netlify login", terminal: term, open: async () => false, timeoutMs: 60_000, now: () => t });
    const pty = await firstPty(link);
    await tick();
    link.data(pty, "Opening https://app.netlify.com/authorize?response_type=ticket&ticket=abc \r\n");
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual([]);
    expect(stripVTControlCharacters(term.text())).toContain("could not open a browser here");
    t += OFFER_MS + 1;
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["o"]);
    link.exit(pty, 130);
    expect((await run).exitCode).toBe(130);
  });

  it("kills the pty and reports a timeout when the tool never finishes", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const run = relayPty({ link, command: "gcloud auth login", terminal: term, open: async () => true, timeoutMs: 20 });
    const pty = await firstPty(link);
    const outcome = await run;
    expect(outcome.timedOut).toBe(true);
    expect(pty.killed).toBe(true);
    expect(term.raw).toEqual([true, false]);
  });

  it("a link that drops under the pty ends the relay with the terminal restored", async () => {
    const link = fakePtyLink();
    let drop: (() => void) | undefined;
    link.closed = new Promise<void>(r => (drop = r));
    const term = terminal();
    const run = relayPty({ link, command: "codex login", terminal: term, open: async () => true, timeoutMs: 60_000 });
    await firstPty(link);
    await tick();
    drop!();
    const outcome = await run;
    expect(outcome).toMatchObject({ exitCode: -1, dropped: true, timedOut: false });
    expect(term.raw).toEqual([true, false]);
  });

  it("a bare shell writes no command line and leaves raw mode alone off a tty", async () => {
    const link = fakePtyLink();
    const term = terminal(false);
    const run = relayPty({ link, terminal: term, open: async () => true, timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    expect(pty.writes).toEqual([]);
    expect(term.raw).toEqual([]);
    term.input.write("exit\r");
    await tick();
    expect(pty.writes).toEqual(["exit\r"]);
    link.exit(pty, 0);
    await run;
  });
});

describe("the questions a row declares", () => {
  const ENTER = { asks: /Press \[?Enter\]? to (?:open|continue)/, answer: "\r" };
  const THEIRS = { asks: /SSO session name \(Recommended\)/, person: true } as const;
  const answers = (asked: readonly Asked[]): (string | undefined)[] => asked.map(a => ("answer" in a.question ? a.question.answer : undefined));

  it("reports each question once, past the colours the tool paints it in, and stops reading once every one is seen", () => {
    const scanner = new QuestionScanner([ENTER, { asks: /Authenticate Git with your GitHub credentials\?/, answer: "y\r" }]);
    // The colours gh puts around "Press Enter" sit inside the line, so the shape only matches with them taken out.
    expect(scanner.feed("\x1b[0;33m!\x1b[0m First copy your one-time code: \x1b[0;1;39m72F3-072B\x1b[0m\r\n")).toEqual([]);
    expect(answers(scanner.feed("\x1b[0;1;39mPress Enter\x1b[0m to open https://github.com/login/device in your browser... "))).toEqual(["\r"]);
    // The same line again is a redraw, not a second question.
    expect(scanner.feed(ASKED.ghWeb)).toEqual([]);
    expect(answers(scanner.feed(ASKED.ghCredentials))).toEqual(["y\r"]);
    expect(scanner.feed(ASKED.ghCredentials)).toEqual([]);
  });

  it("sees a question the pty split across two chunks, and an escape sequence split with it", () => {
    const split = new QuestionScanner([ENTER]);
    expect(split.feed("Press Ent")).toEqual([]);
    expect(answers(split.feed("er to open https://github.com/login/device in your browser... "))).toEqual(["\r"]);
    // The escapes come out of the joined text, so a sequence cut in half by a read boundary hides nothing.
    const escaped = new QuestionScanner([ENTER]);
    expect(escaped.feed("\x1b[0;1;39mPress Enter\x1b[")).toEqual([]);
    expect(answers(escaped.feed("0m to open https://github.com/login/device in your browser... "))).toEqual(["\r"]);
    const quiet = new QuestionScanner([]);
    expect(quiet.feed(ASKED.ghWeb)).toEqual([]);
  });

  it("carries the tool's own words for a question, which is all a row can say about one nobody here can answer", () => {
    expect(new QuestionScanner([THEIRS]).feed(ASKED.awsSso)).toEqual([{ question: THEIRS, matched: "SSO session name (Recommended)" }]);
  });

  it("types an answer on the tool's own pty as the line arrives, reports every question, and types nothing for one that is the person's", async () => {
    const run = async (questions: readonly Question[]) => {
      const link = fakePtyLink();
      const seen: string[] = [];
      link.script = (pty: FakePty, line: string) => {
        if (!line.includes("; exec bash -c ")) return;
        link.data(pty, `! First copy your one-time code: 72F3-072B\r\n`);
        link.data(pty, `Press Enter to open https://github.com/login/device in your browser... `);
        link.data(pty, `SSO session name (Recommended): `);
      };
      await watchPty({ link, command: "gh auth login --web", timeoutMs: 100, questions, onQuestion: a => seen.push(a.matched) });
      return { ran: link.ptys[0]!.ran, writes: link.ptys[0]!.writes.slice(1), seen };
    };
    expect(await run([ENTER])).toEqual({ ran: "gh auth login --web", writes: ["\r"], seen: ["Press Enter to open"] });
    expect(await run([THEIRS])).toEqual({ ran: "gh auth login --web", writes: [], seen: ["SSO session name (Recommended)"] });
    expect(await run([])).toEqual({ ran: "gh auth login --web", writes: [], seen: [] });
  });
});

describe("watchPty", () => {
  it("answers, reports and reads nothing the shell printed before the tool started", async () => {
    const link = fakePtyLink();
    link.banner = "Press Enter to open https://evil.example/login\r\n";
    const seen: string[] = [];
    const asked: string[] = [];
    const chunks: string[] = [];
    link.script = (pty, line) => {
      if (line.includes("; exec bash -c ")) link.exit(pty, 0);
    };
    await watchPty({ link, command: "gh auth login --web", timeoutMs: 1_000, flushMs: 5, questions: [{ asks: /Press Enter to open/, answer: "\r" }], onQuestion: a => asked.push(a.matched), onUrl: u => seen.push(u), onData: c => chunks.push(c) });
    expect({ seen, asked, writes: link.ptys[0]!.writes.length }).toEqual({ seen: [], asked: [], writes: 1 });
    expect(chunks.join("")).not.toContain("evil");
  });

  it("runs the command on a wide pty with nothing typed back, reports each page once, and ends with the tool's exit", async () => {
    const link = fakePtyLink();
    const seen: string[] = [];
    const chunks: string[] = [];
    link.script = (pty, line) => {
      if (!line.includes("; exec bash -c ")) return;
      link.data(pty, `visit https://github.com/login/device to sign in\r\n`);
      link.data(pty, `still https://github.com/login/device, then https://github.com/settings\r\n`);
      link.exit(pty, 0);
    };
    const out = await watchPty({ link, command: "gh auth login", timeoutMs: 60_000, onUrl: u => seen.push(u), onData: c => chunks.push(c) });
    expect(out).toEqual({ exitCode: 0, timedOut: false, dropped: false, stopped: false });
    expect(seen).toEqual(["https://github.com/login/device", "https://github.com/settings"]);
    expect(chunks.join("")).toContain("visit https://github.com/login/device");
    expect(link.ptys[0]!.created).toMatchObject({ cols: 200, rows: 50, shell: "bash" });
    expect(link.ptys[0]!.ran).toBe("gh auth login");
    expect(link.ptys[0]!.writes).toHaveLength(1);
    expect(link.ptys[0]!.killed).toBe(true);
  });

  it("the caller's stop, a link that goes away and a timeout each end it with no exit code, and the pty is killed either way", async () => {
    const held = () => {
      const link = fakePtyLink();
      link.script = (pty, line) => {
        if (line.includes("; exec bash -c ")) link.data(pty, "waiting for you...\r\n");
      };
      return link;
    };
    const stopping = held();
    let settle: (() => void) | undefined;
    const stop = new Promise<void>(r => (settle = r));
    const stopped = watchPty({ link: stopping.dial(), command: "gh auth login", timeoutMs: 60_000, stop });
    await firstPty(stopping);
    await tick();
    settle!();
    expect(await stopped).toEqual({ exitCode: -1, timedOut: false, dropped: false, stopped: true });
    expect(stopping.ptys[0]!.killed).toBe(true);

    const dropping = held();
    const gone = watchPty({ link: dropping.dial(), command: "gh auth login", timeoutMs: 60_000 });
    await firstPty(dropping);
    await tick();
    dropping.drop();
    expect(await gone).toMatchObject({ exitCode: -1, dropped: true, stopped: false });

    const slow = held();
    expect(await watchPty({ link: slow, command: "gh auth login", timeoutMs: 20 })).toEqual({ exitCode: -1, timedOut: true, dropped: false, stopped: false });
    expect(slow.ptys[0]!.killed).toBe(true);
  });
});

describe("a refused pty op", () => {
  const refusing = (op: string) => {
    const link = fakePtyLink();
    const real = link.op.bind(link);
    link.op = async (name, extra = {}) => {
      if (name !== op) return real(name, extra);
      link.ops.push({ op: name, extra });
      return { id: 1, ok: false, error: `${op} is not allowed here` };
    };
    return link;
  };

  it("pty.create answered ok:false throws with the daemon's reason, so nothing goes raw and no attach or write follows", async () => {
    const link = refusing("pty.create");
    const term = terminal();
    await expect(relayPty({ link, command: "gh auth login", terminal: term, open: async () => true, timeoutMs: 60_000 })).rejects.toThrow("pty.create refused: pty.create is not allowed here");
    expect(term.raw).toEqual([]);
    expect(link.ops.map(o => o.op)).toEqual(["pty.create"]);
    await expect(runQuiet(link, "gh auth status", 5_000)).rejects.toThrow("pty.create refused: pty.create is not allowed here");
    expect(link.ops.map(o => o.op)).toEqual(["pty.create", "pty.create"]);
  });

  it("pty.attach answered ok:false throws too, with the pty killed and the terminal untouched", async () => {
    const link = refusing("pty.attach");
    const term = terminal();
    await expect(relayPty({ link, command: "gh auth login", terminal: term, open: async () => true, timeoutMs: 60_000 })).rejects.toThrow("pty.attach refused");
    expect(term.raw).toEqual([]);
    expect(link.ptys[0]!.killed).toBe(true);
    expect(link.ptys[0]!.writes).toEqual([]);
    await expect(runQuiet(link, "gh auth status", 5_000)).rejects.toThrow("pty.attach refused");
    expect(link.ptys[1]!.killed).toBe(true);
  });
});

describe("runQuiet", () => {
  it("runs the status command in a promptless sh and returns only what sits between the echo and the exit marker", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.startsWith("gh auth status")) {
        link.data(pty, "github.com\r\n  ✓ Logged in to github.com account someone (keyring)\r\n  - Token: gho_****\r\n\r\nWSP_STATUS 1\r\n");
        link.exit(pty, 1);
      }
    };
    const res = await runQuiet(link, "gh auth status", 5_000);
    expect(link.ptys[0]!.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "" } });
    expect(link.ptys[0]!.ran).toBe("gh auth status");
    expect(link.ptys[0]!.writes).toHaveLength(1);
    expect([...link.staged.values()]).toEqual([{ command: "gh auth status", cleared: true }]);
    expect(res).toEqual({ output: "github.com\n  ✓ Logged in to github.com account someone (keyring)\n  - Token: gho_****", exitCode: 1, timedOut: false, dropped: false });
    expect(link.ptys[0]!.killed).toBe(true);
  });

  it("hands back the output as plain text: a tool that colours into the pty (opencode 1.18.18 paints key names) reads as words", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.startsWith("opencode auth list")) {
        link.data(pty, "\x1b[0m\r\n●  Anthropic \x1b[90mANTHROPIC_API_KEY\r\n│\r\n└  1 environment variable\r\n\r\nWSP_STATUS 0\r\n");
        link.exit(pty, 0);
      }
    };
    const res = await runQuiet(link, "opencode auth list", 5_000);
    expect(res.output).toBe("●  Anthropic ANTHROPIC_API_KEY\n│\n└  1 environment variable");
  });

  it("times out a status command that never answers", async () => {
    const link = fakePtyLink();
    const res = await runQuiet(link, "codex login status", 20);
    expect(res).toEqual({ output: "", exitCode: -1, timedOut: true, dropped: false });
    expect(link.ptys[0]!.killed).toBe(true);
  });

  it("a link that drops during the status command reads as dropped, not as an answer", async () => {
    const link = fakePtyLink();
    const view = link.dial();
    const run = runQuiet(view, "codex login status", 5_000);
    await firstPty(link);
    await tick();
    link.drop();
    expect(await run).toEqual({ output: "", exitCode: -1, timedOut: false, dropped: true });
  });
});
