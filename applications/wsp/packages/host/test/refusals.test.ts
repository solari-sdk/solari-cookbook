// SPDX-License-Identifier: AGPL-3.0-only
// The shape every refusal wsp leaves on a terminal: two halves, what happened
// then what to do, the command's name said once, and a word no command answers
// to met with a pointer at the help rather than the help itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, unclosedQuoteRefusal } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELP, cli } from "../src/cli.js";
import { CLI_VERBS } from "../src/verbs.js";
import { captured, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

describe("what wsp says when it will not run a line", () => {
  let dir: string;
  let statePath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-refusals-"));
    statePath = join(dir, "state.json");
    env = { HOME: join(dir, "user"), WSP_HOME: join(dir, "home") };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (...argv: string[]): Promise<{ code: number; io: Captured }> => {
    const io = captured();
    // Nothing starts a host here: what a refused line says is the whole of this file, and a line that got as far as
    // the dial is held to the one sentence it leaves when there is nothing to reach.
    const code = await cli([...argv, "--state", statePath], io, undefined, env, false);
    return { code, io };
  };

  it("answers a word no command has with that word and where the list is, on one line, and never with the help", async () => {
    for (const word of ["ls", "list", "nope"]) {
      const { code, io } = await run(word);
      expect(code, word).toBe(EXIT_CODES.usage);
      expect(io.lines, word).toEqual([]);
      expect(io.errors, word).toEqual([`unknown command: ${word}. Run wsp --help for the list.`]);
      expect(io.errors.join("\n").split("\n"), word).toHaveLength(1);
    }
  });

  it("answers an unknown word under mcp and under host the same way, one line and a pointer, with no usage dump", async () => {
    const mcp = await run("mcp", "nope");
    expect(mcp.code).toBe(EXIT_CODES.usage);
    expect(mcp.io.errors).toEqual(["unknown command: mcp nope. Run wsp mcp --help for the list."]);
    // The word the plumbing folds under opens lines rather than being one, so it answers with the lines it opens.
    const host = await run("host", "nope");
    expect(host.code).toBe(EXIT_CODES.usage);
    expect(host.io.errors).toHaveLength(1);
    expect(host.io.errors[0]).toContain("wsp host opens a line rather than being one.");
    expect(host.io.errors[0]).toContain("usage: wsp host pair");
  });

  it("takes help as the word for the flag, printing what wsp --help prints and exiting 0", async () => {
    const word = await run("help");
    const flag = await run("--help");
    expect(word.code).toBe(0);
    expect(word.io.errors).toEqual([]);
    expect(word.io.lines).toEqual(flag.io.lines);
    expect(word.io.lines).toEqual([HELP]);
  });

  it("names the third word when a thread is opened on more than a workspace and a task", async () => {
    const { code, io } = await run("run", "api", "say hi", "and this");
    expect(code).toBe(EXIT_CODES.usage);
    expect(io.errors[0]).toContain("wsp run takes a workspace and a task; and this reads as a third word.");
    // The name is the line's own prefix, so the sentence behind it never says it a second time.
    expect(io.errors[0]!.startsWith("wsp run: wsp run")).toBe(false);
  });

  it("refuses a second word on the account's lines rather than running on the first and dropping it", async () => {
    // A word nobody reads is a line that did something other than what was typed, and the three account lines
    // take one word at most.
    const login = await run("login", "https://relay.example", "extra");
    expect(login.code).toBe(EXIT_CODES.usage);
    expect(login.io.errors[0]).toContain("wsp login takes one word, and got 2.");
    const logout = await run("logout", "c1", "c2");
    expect(logout.code).toBe(EXIT_CODES.usage);
    expect(logout.io.errors[0]).toContain("wsp logout takes one word, and got 2.");
    const hosts = await run("hosts", "box");
    expect(hosts.code).toBe(EXIT_CODES.usage);
    expect(hosts.io.errors[0]).toContain("wsp hosts takes no words, and got box.");
  });

  it("answers a word wsp used to have as it answers any other word nothing knows: one line and the pointer, with nothing dialled", async () => {
    // No old word is kept as a road, hidden or otherwise: the release note says what moved, once, and the command
    // line carries none of it.
    // wsp hosts is a line wsp answers to; the words below are the ones that are gone for good.
    for (const argv of [["pair"], ["devices"], ["connect", "http://box:4400"], ["disconnect", "box"]]) {
      const { code, io } = await run(...argv);
      const line = argv.join(" ");
      expect(code, line).toBe(EXIT_CODES.usage);
      expect(io.lines, line).toEqual([]);
      expect(io.errors, line).toEqual([`unknown command: ${argv[0]!}. Run wsp --help for the list.`]);
    }
    // A word that still opens lines answers with the lines it opens, whatever it used to open.
    const thread = await run("thread", "new", "x", "t");
    expect(thread.code).toBe(EXIT_CODES.usage);
    expect(thread.io.errors[0]).toContain("wsp thread opens a line rather than being one.");
    const relay = await run("relay", "link", "http://relay");
    expect(relay.code).toBe(EXIT_CODES.usage);
    expect(relay.io.errors).toEqual(["unknown command: relay. Run wsp --help for the list."]);
    // A flag wsp used to read is the parser's own unknown option, with the line's usage under it.
    for (const argv of [["threads", "--in", "alpha"], ["new", "x", "--local"], ["new", "x", "--ssh", "maya@box"]]) {
      const { code, io } = await run(...argv);
      const line = argv.join(" ");
      expect(code, line).toBe(EXIT_CODES.usage);
      expect(io.errors[0], line).toContain("Unknown option");
      expect(io.errors[0], line).toContain("usage: wsp ");
    }
    // --on is read by the lists of a computer, so on another verb it is that verb's stray flag rather than an unknown one.
    const on = await run("new", "x", "--on", "here");
    expect(on.code).toBe(EXIT_CODES.usage);
    expect(on.io.errors[0]).toContain("--on belongs to wsp agents, wsp skills, wsp skills show, wsp skills add, wsp skills remove, wsp skills disable, wsp skills enable, wsp servers, wsp servers signin, wsp servers tools, wsp servers add, wsp servers remove, wsp servers disable, wsp servers enable and wsp folders; wsp new does not read it");
  });

  it("refuses a server's command line with a quote it never closes before anything is dialled", async () => {
    const { code, io } = await run("servers", "add", "acme", "--agent", "codex", "--command", 'npx "unclosed');
    expect(code).toBe(EXIT_CODES.usage);
    expect(io.errors[0]).toContain(unclosedQuoteRefusal);
  });

  it("says a thread opened on no words at all what to put in quotes", async () => {
    const { code, io } = await run("run");
    expect(code).toBe(EXIT_CODES.usage);
    expect(io.errors).toEqual(['wsp run takes a task and got none. Put the task in quotes: wsp run <workspace> "say hi".']);
  });

  it("answers every verb in one line that never says the verb's name twice over, and refuses one with both halves", async () => {
    // Three words is more than any verb takes, so each one answers here rather than reaching for a host; the three
    // that read a list of words get as far as the dial, which has no host to reach and says so in one line too.
    for (const verb of CLI_VERBS) {
      const name = `wsp ${verb.name}`;
      const { code, io } = await run(...verb.name.split(" "), "zzz1", "zzz2", "zzz3");
      expect(io.lines, name).toEqual([]);
      expect(io.errors, name).toHaveLength(1);
      const line = io.errors[0]!;
      expect(line.split("\n"), name).toHaveLength(1);
      // The prefix is the one home for the verb's name; a sentence that opens with it again is the doubling.
      expect(line.startsWith(`${name}: ${name}`), `${name}: ${line}`).toBe(false);
      // A line refused before anything ran carries what to do: the verb's own usage, or a sentence of its own.
      if (code === EXIT_CODES.usage) expect(line, name).toMatch(/(?:usage: |\. [A-Z])/);
      else expect(code, `${name}: ${line}`).toBe(EXIT_CODES.provider);
    }
  });
});
