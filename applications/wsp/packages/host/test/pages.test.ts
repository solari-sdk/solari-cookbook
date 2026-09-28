// SPDX-License-Identifier: AGPL-3.0-only
// What wsp prints when a person asks what it is: sixteen words on the front
// page, every other line one page in, and no page, tool description, skill row
// or doc holding a word wsp no longer answers to.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "@wsp/protocol";
import { agentPage, cli, COMMAND_LINES, devPage, HELP, HOST_STARTS_ITSELF, hostPage, MCP_OPTIONS, SHARED_FLAGS, type CliIO } from "../src/cli.js";
import { WSP_SKILL, INSTRUCTIONS } from "../src/skill.js";
import { CLI_VERBS, hasTool, THREAD_PREFIX_WORD, VERBS } from "../src/verbs.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const captured = (): CliIO & { lines: string[]; errors: string[] } => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt };
};

/** The sixteen words, in the order the front page prints them. */
const FRONT = ["init", "add", "computers", "remove", "projects", "new", "workspaces", "threads", "run", "send", "stop", "pause", "wake", "delete", "status", "mcp"];

/** The three lines about the person's own account, which print in the block under the sixteen rather than among
 * them: they are not work on a workspace, and a person meets them once. */
const ACCOUNT = ["login", "logout", "hosts"];

/** Every line the front page draws: one per word, each opening at two spaces. */
const frontLines = (): string[] => HELP.split("\n").filter(line => line.startsWith("  wsp "));

/** Every file under a folder, at any depth. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

describe("the pages wsp prints", () => {
  it("the front page is the sixteen words on five nouns and nothing else a person has to read past", () => {
    expect(frontLines()).toHaveLength(16);
    expect(frontLines().map(line => line.trim().split(" ")[1])).toEqual(FRONT);
    // Each of the sixteen is a line that declares the front page, and no other line does.
    expect(COMMAND_LINES.filter(l => l.page === "front").map(l => l.words).sort()).toEqual([...FRONT, ...ACCOUNT].sort());
    // The three rules and the two pages behind it, which is what makes "nothing else" findable.
    expect(HELP).toContain("A workspace or a thread comes right after the verb.");
    expect(HELP).toContain("new takes the project when");
    expect(HELP).toContain("Sleeping is automatic.");
    expect(HELP).toContain("wsp --help agent");
    expect(HELP).toContain("wsp host --help");
  });

  it("the front page names the two lines that serve a host, and the agent page's own line no longer stands in for them", () => {
    // Both testers learned the word up from a launchd line in wsp status, after hunting through a page titled for
    // their agents. It is on the page they read first now.
    const block = HELP.split("\n\n").at(-1)!;
    expect(block).toContain("wsp up ");
    expect(block).toContain("wsp down ");
    // The account's three lines print there too: a person signs this computer in once and reaches every host on it.
    for (const words of ACCOUNT) expect(block, words).toContain(`wsp ${words}`);
    expect(HELP).toContain(HOST_STARTS_ITSELF);
    expect(HELP).not.toContain("and up and down");
    // The page for agents still carries their flags, under a title that says who the lines on it are for, and the
    // claim about a host starting itself is one sentence both pages read.
    expect(agentPage()).toContain("wsp up [--port");
    expect(agentPage()).toContain("the lines you type yourself");
    expect(agentPage()).toContain(HOST_STARTS_ITSELF);
    // And it is true of the two words a person types second: both are handed the run's starter.
    expect(agentPage()).toContain("otherwise the host the command line brought up");
  });

  it("the agent page says a reply is printed once, not that stdout carries a second copy of it", () => {
    // The page taught the double print as the design, and a tester read his reply twice and called it noise.
    const page = agentPage().replace(/\s+/g, " ");
    expect(page).toContain("print it once");
    expect(page).not.toContain("prints the last message on stdout when the reply is complete");
  });

  it("the front page names the line that reads a thread back, and the line that hands over a thread id names it too", () => {
    // Marco could start a thread and wait for it and had no way to read what it said; the verb existed, one page in.
    expect(HELP).toContain("wsp thread read <thread> prints what a thread said");
    expect(THREAD_PREFIX_WORD).toBe("wsp thread read, wsp send and wsp stop take its first characters");
  });

  it("the front page's init line says what init does in the person's words, and none of the five words a tester could not read is on the page at all", () => {
    // Priya skipped wsp init outright: she did not know what sealing was, whether it was reversible, or what it
    // would take from her machine, and "once" read as permanent. The other four she named are words for what is
    // under the product, not for what a person does with it, and the first page carries none of them.
    const init = frontLines().find(line => line.trim().startsWith("wsp init"))!;
    const row = HELP.split("\n").slice(HELP.split("\n").indexOf(init), HELP.split("\n").indexOf(init) + 2).join(" ");
    expect(row).toContain("set this computer up");
    for (const word of ["seal", "once", "place", "recipe", "tick"]) expect(HELP, word).not.toContain(word);
    // The one the front page does still need is the noun for a folder on a computer, which is a project.
    expect(HELP).toContain("wsp projects");
  });

  it("the rules under the front page hold against the lines above them, and the page fits one screen", () => {
    // A summary the list under it contradicts is worse than no summary: a reader who checks the claim against the
    // rows stops believing the page. Each clause of the sentence is held to the rows here.
    // The usage line at the top is a claim of the same kind, so it says no more than the sentence under the rows:
    // `wsp <verb> <workspace> ...` named a positional that send, stop, remove, places and status do not take.
    expect(HELP.split("\n\n")[1]).toBe("usage: wsp <verb> ...");
    const rows = frontLines().map(line => /^ {2}(wsp .*?)(?: {2,}|$)/.exec(line)![1]!);
    for (const usage of rows) {
      const words = usage.split(" ");
      // Wherever a line takes a workspace or a thread, it takes it right after the verb and nowhere else.
      for (const [at, word] of words.entries()) {
        if (/^\[?<(workspace|thread)>\]?$/.test(word)) expect(at, usage).toBe(2);
      }
    }
    // The only flag named anywhere in the rows is the one the sentence says a person meets, and it is on add.
    const block = HELP.split("\n\n")[2]!;
    expect(block.split("\n").filter(line => line.includes("--")).map(line => line.trim())).toEqual(["with --on <computer>"]);
    // run and send take the agent's own flags, as the sentence says, and their own help is where they are listed.
    // Send takes two of the three: a thread's access is the thread's own and a message does not change it.
    const reads = (name: string, pick: string): boolean => Object.hasOwn(CLI_VERBS.find(v => v.name === name)!.options, pick);
    for (const pick of ["model", "effort", "access"]) expect(reads("run", pick), `wsp run reads --${pick}`).toBe(true);
    for (const pick of ["model", "effort"]) expect(reads("send", pick), `wsp send reads --${pick}`).toBe(true);
    expect(reads("send", "access"), "wsp send does not read --access").toBe(false);
    // A normal terminal's worth of rows: the page is read whole or it is not read. Three of them are the account's
    // lines, which came with signing in once.
    expect(HELP.split("\n").length).toBeLessThanOrEqual(43);
  });

  it("every line declares a page, and each page names its own lines and no others", () => {
    for (const line of COMMAND_LINES) expect(line.page, line.words).toMatch(/^(front|agent|host|dev|app)$/);
    // The words a page names are the ones its usage lines open with, the longest match first, so wsp workspaces
    // agents is not read as wsp workspaces.
    const wordsOn = (text: string): string[] => {
      const usages = text.split("\n").filter(l => /^ {2}wsp /.test(l)).map(l => l.trim().slice("wsp ".length));
      // A usage carries its arguments after the words, never more prose: the notes under a page open with a verb's
      // name too, and a word followed by another word is one of those.
      const opens = (u: string, words: string): boolean => u === words || /^[^a-z]/.test(u.slice(words.length + 1));
      return [...new Set(usages.map(u => [...COMMAND_LINES].sort((a, b) => b.words.length - a.words.length).find(c => (u === c.words || u.startsWith(`${c.words} `)) && opens(u, c.words))?.words).filter((w): w is string => w !== undefined))];
    };
    const named = (page: string, text: string): void => {
      expect(wordsOn(text).sort(), page).toEqual(COMMAND_LINES.filter(l => l.page === page).map(l => l.words).sort());
    };
    named("agent", agentPage());
    named("host", hostPage());
    // The dev page is the doctor and nothing else.
    expect(devPage()).toContain("wsp doctor");
    expect(COMMAND_LINES.filter(l => l.page === "dev").map(l => l.words)).toEqual(["doctor"]);
    // A line the app's own screens stand on prints nowhere, and is still parsed and still served.
    const apps = COMMAND_LINES.filter(l => l.page === "app");
    expect(apps.length).toBeGreaterThan(0);
    for (const line of apps) for (const page of [HELP, agentPage(), hostPage(), devPage()]) expect(page, line.words).not.toContain(`wsp ${line.words}`);
  });

  it("every line of every page fits a hundred columns", () => {
    for (const [name, page] of [["front", HELP], ["agent", agentPage()], ["host", hostPage()], ["dev", devPage()]] as const) {
      for (const line of page.split("\n")) expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(100);
    }
  });

  it("a page is reached by its own word, a command by its own flag, and a word no page answers to is refused", async () => {
    const agent = captured();
    expect(await cli(["--help", "agent"], agent, undefined, {}, false)).toBe(0);
    expect(agent.lines).toEqual([agentPage()]);
    const host = captured();
    expect(await cli(["host", "--help"], host, undefined, {}, false)).toBe(0);
    expect(host.lines).toEqual([hostPage()]);
    // The word on its own is the same question as the word with the flag.
    const bare = captured();
    expect(await cli(["host"], bare, undefined, {}, false)).toBe(0);
    expect(bare.lines).toEqual([hostPage()]);
    const dev = captured();
    expect(await cli(["help", "dev"], dev, undefined, {}, false)).toBe(0);
    expect(dev.lines).toEqual([devPage()]);
    const nope = captured();
    expect(await cli(["--help", "nope"], nope, undefined, {}, false)).toBe(EXIT_CODES.usage);
    expect(nope.errors[0]).toContain("wsp --help takes a page, and got nope.");
    // The word and the flag are one road: help before a command is that command's own help.
    const byWord = captured();
    expect(await cli(["help", "up"], byWord, undefined, {}, false)).toBe(0);
    const byFlag = captured();
    expect(await cli(["up", "--help"], byFlag, undefined, {}, false)).toBe(0);
    expect(byWord.lines).toEqual(byFlag.lines);
    const folded = captured();
    expect(await cli(["help", "host", "pair"], folded, undefined, {}, false)).toBe(0);
    expect(folded.lines[0]).toContain("usage: wsp host pair");
  });

  it("a command's own help is its usage, what it does and its own flags, and a flag another command reads is refused naming it", async () => {
    const up = captured();
    expect(await cli(["up", "--help"], up, undefined, {}, false)).toBe(0);
    expect(up.lines[0]).toContain("usage: wsp up");
    expect(up.lines[0]).toContain("--service");
    // init's flags are init's; up's page never advertises them.
    expect(up.lines[0]).not.toContain("--recipe");
    const init = captured();
    expect(await cli(["init", "--help"], init, undefined, {}, false)).toBe(0);
    expect(init.lines[0]).toContain("usage: wsp init");
    expect(init.lines[0]).toContain("--recipe");
    expect(init.lines[0]).not.toContain("--service");
    const foreign = captured();
    expect(await cli(["down", "--recipe", "x"], foreign, undefined, {}, false)).toBe(EXIT_CODES.usage);
    expect(foreign.errors[0]).toBe("--recipe belongs to wsp init; wsp down does not read it. usage: wsp down");
  });

  it("the tool server's own two pages say what each does and give each flag it reads a line", async () => {
    // Two usage lines and no words was the whole of it, so nobody could read what --agent took.
    const serve = captured();
    expect(await cli(["mcp", "--help"], serve, undefined, {}, false)).toBe(0);
    expect(serve.lines[0]).toContain("usage: wsp mcp");
    expect(serve.lines[0]).toContain("serve the verbs as tools over stdio");
    const install = captured();
    expect(await cli(["mcp", "install", "--help"], install, undefined, {}, false)).toBe(0);
    expect(install.lines[0]).toContain("usage: wsp mcp install");
    for (const flag of ["--agent", "--remove", "--json", "--state", "--host"]) expect(install.lines[0], flag).toContain(flag);
    // Every flag its parse reads has a line on one of the two pages; --help is the flag that prints the page.
    for (const name of Object.keys(MCP_OPTIONS).filter(n => n !== "help")) expect(`${serve.lines[0]}\n${install.lines[0]}`, name).toContain(`--${name}`);
  });

  it("every flag a command of the shared parse reads has a row naming the commands that read it", () => {
    for (const flag of SHARED_FLAGS) {
      expect(flag.says, flag.name).toMatch(/\S/);
      expect(flag.on.length, flag.name).toBeGreaterThan(0);
      for (const words of flag.on) expect(COMMAND_LINES.some(l => l.words === words), `${flag.name} names wsp ${words}`).toBe(true);
    }
  });

  it("no sentence the host prints carries a word the cut took out: no golden, no wspx, no reach loop", () => {
    // The cut reached the front page and the verbs' usage lines and stopped, so the refusals, the init screens and
    // the doctor kept the old nouns. Every literal the host is built from is held to the five nouns here: a word
    // with no whitespace in it is a name (a wire op, a file, a path segment) and is left alone, and an expression
    // inside a template is code, not words a person reads.
    const gone: [RegExp, string][] = [
      [/goldens?\b/i, "golden: the noun is image"],
      [/\bwspx\s/, "wspx: a person runs wsp"],
      [/\breach loop\b/i, "the reach loop: say what is being proved"],
    ];
    const said: string[] = [];
    const check = (where: string, text: string): void => {
      for (const [word, why] of gone) if (word.test(text)) said.push(`${where}: ${why}; in ${JSON.stringify(text.slice(0, 120))}`);
    };
    for (const file of filesUnder(join(REPO, "packages/host/src")).filter(f => f.endsWith(".ts"))) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [at, line] of code.split("\n").entries()) {
        if (line.trimStart().startsWith("//")) continue;
        for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
          const literal = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
          if (/\s/.test(literal)) check(`${file.slice(REPO.length)}:${at + 1}`, literal);
        }
      }
    }
    // The skill is inlined into the same build, so it is one of the strings the host carries.
    check("the skill", WSP_SKILL);
    expect(said).toEqual([]);
  });

  it("no page, tool description, skill, instruction, AGENTS.md, README or doc carries a word wsp no longer answers to", () => {
    // "--in <" alone let three rows of the skill keep the flag in backticks with no value after it.
    // wsp hosts is a line wsp answers to, so it is no banned word; the ones below are gone for good.
    const banned = ["thread new", "thread_new", "--in <", "`--in`", "--to <", "new --local", "new --ssh", "wsp connect", "wsp relay", "wsp pair", "wsp devices", "wsp disconnect", "wsp host list", "wsp host linked", "wsp host clients", "run wsp up first"];
    const docs = filesUnder(join(REPO, "apps/docs/content")).filter(p => p.endsWith(".mdx") || p.endsWith(".md"));
    const texts: [string, string][] = [
      ["the front page", HELP],
      ["the agent page", agentPage()],
      ["the host page", hostPage()],
      ["the dev page", devPage()],
      ["the skill", WSP_SKILL],
      ["the instructions", INSTRUCTIONS],
      ["AGENTS.md", readFileSync(join(REPO, "AGENTS.md"), "utf8")],
      // The release note is the one place an old word is written down, and it is written once, in a marked block
      // the release after this one deletes. Everything else in the README is held to the new words.
      ["README.md", readFileSync(join(REPO, "README.md"), "utf8").replace(/<!-- renames:start -->[\s\S]*?<!-- renames:end -->/, "")],
      ...VERBS.filter(hasTool).map(v => [`the ${v.name} tool`, v.tool.description] as [string, string]),
      ...CLI_VERBS.map(v => [`wsp ${v.name}`, `${v.usage}\n${v.about}`] as [string, string]),
      ...docs.map(p => [p.slice(REPO.length), readFileSync(p, "utf8")] as [string, string]),
    ];
    const found = texts.flatMap(([where, text]) => banned.filter(word => text.includes(word)).map(word => `${where}: ${word}`));
    expect(found).toEqual([]);
  });
});
