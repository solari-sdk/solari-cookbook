// SPDX-License-Identifier: AGPL-3.0-only
// Codex's global config as the machine gets it. Its one hook is `notify`, the
// argv of a program Codex runs after every turn (https://developers.openai.com/
// codex/config-advanced), so a copy that names a program or a script the
// machine has no file for runs a missing command every turn: that key comes
// out. One module per agent, registered on the catalog entry beside the Claude
// rule, and the words go through that rule's own reading of what a command runs.
// The file is read line by line so every other key, its comments, its order and
// its spacing survive.
import { onMachine, pathOf, placeWord, runsAFile, type CarriedHooks, type HookCarry, type HookPlacer } from "./hooks.js";
import { rewriteTomlLine, tomlOpenArray, tomlStrings, uncommentToml } from "./mcp.js";

export const CODEX_CONFIG_FILE = "~/.codex/config.toml";

const NOTIFY = /^\s*notify\s*=/;
const COMMENT = /^\s*#/;

type Carried = CarriedHooks["carried"];

/** The argv Codex runs after a turn: the program, then its arguments. A program that names a path has to be one the
 * image has, since a binary built for this computer would not run there whatever a copy of it landed as. When the
 * program is an interpreter the machine has, the file it runs is the first word after its flags, and that one
 * travels if the placer takes it. Nothing when no word has to move. */
function carryNotify(words: readonly string[], home: string, place: HookPlacer): { words: readonly string[]; carried: Carried } | { left: string } | undefined {
  const program = words[0];
  if (program === undefined) return undefined;
  const path = pathOf(program, home);
  if (path !== undefined && !onMachine(path)) return { left: program };
  if (!runsAFile(program, home)) return undefined;
  const at = words.findIndex((w, i) => i > 0 && !w.startsWith("-"));
  if (at < 0) return undefined;
  const placed = placeWord(words[at]!, home, place);
  if ("left" in placed) return { left: placed.left };
  if (placed.carried === undefined) return undefined;
  return { words: words.map((w, i) => (i === at ? placed.word : w)), carried: [placed.carried] };
}

export const CODEX_HOOKS: HookCarry = {
  file: CODEX_CONFIG_FILE,
  carry(text, home, place) {
    const lines = text.split("\n");
    const kept: string[] = [];
    const carried: Carried = [];
    const left: string[] = [];
    let table = false;
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const code = uncommentToml(lines[i]!);
      // Only the `notify` written before the first table header is the program; one under a table belongs to that
      // table. A line-by-line reader takes any code line opening with `[` for a header, so a top-level array spread
      // over lines, or a multi-line string holding such a line, ends the top of the file early.
      if (code.trim().startsWith("[")) table = true;
      if (table || !NOTIFY.test(code)) {
        kept.push(lines[i]!);
        continue;
      }
      const span = [lines[i]!];
      let value = code.slice(code.indexOf("=") + 1).trim();
      while (tomlOpenArray(value) && i + 1 < lines.length) {
        span.push(lines[++i]!);
        value += uncommentToml(lines[i]!).trim();
      }
      // An array that never closed is not TOML this reads, so it stays as written.
      const words = tomlOpenArray(value) ? [] : tomlStrings(value);
      const out = carryNotify(words, home, place);
      if (out === undefined) {
        kept.push(...span);
        continue;
      }
      changed = true;
      if ("left" in out) {
        left.push(out.left);
        // The comment lines above a key document that key, so they go with it rather than standing over nothing.
        while (kept.length > 0 && COMMENT.test(kept.at(-1)!)) kept.pop();
        continue;
      }
      carried.push(...out.carried);
      const swap = new Map(words.flatMap((w, n) => (out.words[n] === w ? [] : [[w, out.words[n]!] as const])));
      kept.push(...span.map(line => rewriteTomlLine(line, v => swap.get(v) ?? v)));
    }
    return { text: changed ? kept.join("\n") : text, carried, left };
  },
};
