// SPDX-License-Identifier: AGPL-3.0-only
// How an agent's settings file names the hook scripts it runs, so a copy of
// the file can bring each script along at its guest path or take the hook out
// when the script cannot travel. One module per agent, registered on its
// catalog entry: this module knows the file's shape and the command line's,
// the host reads this computer's disk and says where a script lands.
import { readJsonc } from "./jsonc.js";
import { editJson, type JsonEdit } from "./mcp.js";

/** Where a script a hook names lands on the guest, absolute; nothing when it cannot travel. */
export type HookPlacer = (abs: string) => string | undefined;

export interface CarriedHooks {
  /** The settings file as the machine gets it; the input byte for byte when no hook named a file. */
  text: string;
  /** Each script that travels, once: its path on this computer and the guest path the hook now names. */
  carried: { from: string; to: string }[];
  /** The hooks taken out, by the path each named as it was written. */
  left: string[];
}

export interface HookCarry {
  /** The settings file, `~/`-relative. */
  file: string;
  carry(text: string, home: string, place: HookPlacer): CarriedHooks;
}

export const CLAUDE_SETTINGS_FILE = "~/.claude/settings.json";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A word starting with one of these is a path under the home directory as the shell reads it. */
const HOME_PREFIXES = ["~/", "$HOME/", "${HOME}/"];

/** The directories every machine image has binaries in; a hook command under one runs there as it does here. */
const MACHINE_BINS = ["/bin/", "/usr/bin/", "/usr/local/bin/", "/usr/sbin/"];

/** Whether an absolute path names a command the machine has, so the hook passes through unchanged. */
export const onMachine = (abs: string): boolean => MACHINE_BINS.some(d => abs.startsWith(d) && abs.length > d.length);

/** A command word's path on this computer, `~` and `$HOME` expanded; nothing for a word that is not a path. */
export function pathOf(word: string, home: string): string | undefined {
  if (word.startsWith("/")) return word;
  const prefix = HOME_PREFIXES.find(p => word.startsWith(p));
  return prefix === undefined ? undefined : `${home}/${word.slice(prefix.length)}`;
}

/** The command line as runs of whitespace and words, a quoted span with spaces staying one word and a `;` glued to
 * a word its own, so the line joins back as it was. */
function tokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    let j = i;
    if (/\s/.test(line[i]!)) {
      while (j < line.length && /\s/.test(line[j]!)) j++;
      out.push(line.slice(i, j));
    } else {
      let quote: string | undefined;
      while (j < line.length && (quote !== undefined || !/\s/.test(line[j]!))) {
        const c = line[j]!;
        if (quote === undefined && (c === '"' || c === "'")) quote = c;
        else if (c === quote) quote = undefined;
        j++;
      }
      const word = line.slice(i, j);
      if (word.length > 1 && word.endsWith(";") && !/["']$/.test(word.slice(0, -1))) out.push(word.slice(0, -1), ";");
      else out.push(word);
    }
    i = j;
  }
  return out;
}

/** The words that end one simple command and start the next. */
const OPERATORS = new Set(["&&", "||", "|", ";"]);
/** Commands whose first path argument is the script they run, so that script is the hook's file. */
const INTERPRETERS = new Set(["env", "bash", "sh", "zsh", "dash", "node", "bun", "deno", "python", "python3", "ruby", "perl"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Whether a command word runs another file, so the first word after its flags is the file, not this one. */
export function runsAFile(word: string, home: string): boolean {
  return INTERPRETERS.has(pathOf(word, home) === undefined ? word : word.slice(word.lastIndexOf("/") + 1));
}

/** Where a command word lands on the guest: the word as the machine reads it, with the file carried to get it there,
 * or the path the placer refused. A word that names no path, or one the machine already has, is unchanged. */
export type PlacedWord = { word: string; carried?: { from: string; to: string } } | { left: string };

export function placeWord(word: string, home: string, place: HookPlacer): PlacedWord {
  const path = pathOf(word, home);
  if (path === undefined || onMachine(path)) return { word };
  const to = place(path);
  return to === undefined ? { left: word } : { word: to, carried: { from: path, to } };
}

type Rewritten = { command: string; carried: { from: string; to: string }[] } | { left: string };

/** The command with the first word of each simple command, and the script an interpreter runs, rewritten to its
 * guest path or left as written when the machine has it; the first such word the placer refuses. Arguments,
 * redirect targets and everything else pass through untouched. */
function rewriteCommand(command: string, home: string, place: HookPlacer): Rewritten {
  const carried: { from: string; to: string }[] = [];
  let expect: "command" | "script" | "args" = "command";
  const words = tokens(command).map(token => {
    if (/^\s+$/.test(token)) return token;
    if (OPERATORS.has(token)) {
      expect = "command";
      return token;
    }
    if (expect === "args") return token;
    const quote = token.length >= 2 && (token[0] === '"' || token[0] === "'") && token.at(-1) === token[0] ? token[0] : "";
    const word = quote === "" ? token : token.slice(1, -1);
    if (ENV_ASSIGN.test(word) || (expect === "script" && word.startsWith("-"))) return token;
    expect = runsAFile(word, home) ? "script" : "args";
    const placed = placeWord(word, home, place);
    if ("left" in placed) return placed;
    if (placed.carried !== undefined) carried.push(placed.carried);
    return placed.word === word ? token : `${quote}${placed.word}${quote}`;
  });
  const refused = words.find((w): w is { left: string } => typeof w !== "string");
  return refused ?? { command: words.join(""), carried };
}

/** Claude Code's hooks: `hooks` maps an event to groups, each with a matcher and its `hooks`, each of which is a
 * shell command or a prompt. https://docs.claude.com/en/docs/claude-code/hooks */
export const CLAUDE_HOOKS: HookCarry = {
  file: CLAUDE_SETTINGS_FILE,
  carry(text, home, place) {
    const out: CarriedHooks = { text, carried: [], left: [] };
    let parsed: unknown;
    try {
      parsed = readJsonc(text).value;
    } catch {
      return out;
    }
    if (!isRecord(parsed) || !isRecord(parsed["hooks"])) return out;
    const hooks = parsed["hooks"];
    const seen = new Set<string>();
    // Rewrites first, then each removal from the last index back, so every edit's path still names what it did.
    const rewrites: JsonEdit[] = [];
    const removals: JsonEdit[] = [];
    let eventsLeft = 0;
    for (const [event, groups] of Object.entries(hooks)) {
      const gone: JsonEdit[] = [];
      let groupsLeft = 0;
      (Array.isArray(groups) ? groups : []).forEach((group, g) => {
        const cut: JsonEdit[] = [];
        let hooksLeft = 0;
        (isRecord(group) && Array.isArray(group["hooks"]) ? group["hooks"] : []).forEach((hook, h) => {
          if (!isRecord(hook) || typeof hook["command"] !== "string") return void hooksLeft++;
          const r = rewriteCommand(hook["command"], home, place);
          if ("left" in r) {
            out.left.push(r.left);
            cut.unshift([["hooks", event, g, "hooks", h], undefined]);
            return;
          }
          hooksLeft++;
          if (r.command !== hook["command"]) rewrites.push([["hooks", event, g, "hooks", h, "command"], r.command]);
          for (const c of r.carried) {
            if (seen.has(c.from)) continue;
            seen.add(c.from);
            out.carried.push(c);
          }
        });
        const emptied = hooksLeft === 0 && cut.length > 0;
        if (!emptied) groupsLeft++;
        gone.unshift(...(emptied ? [[["hooks", event, g], undefined] as JsonEdit] : cut));
      });
      const emptied = Array.isArray(groups) && groupsLeft === 0 && gone.length > 0;
      if (!emptied) eventsLeft++;
      removals.push(...(emptied ? [[["hooks", event], undefined] as JsonEdit] : gone));
    }
    const edits = eventsLeft === 0 && removals.length > 0 ? [...rewrites, [["hooks"], undefined] as JsonEdit] : [...rewrites, ...removals];
    if (edits.length > 0) out.text = editJson(text, edits);
    return out;
  },
};
