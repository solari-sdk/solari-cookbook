// SPDX-License-Identifier: AGPL-3.0-only
// Every refusal a terminal reads is two halves, what happened and then what to
// do about it. usageRefusal asks for both, so this walks every call of it in
// the repo and reads the halves it was given: a refusal that names the fault
// and leaves the person to work the fix out is the whole of what this guards.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionRefusal, agentsKindRefusal, goneRefusal, goneRoadRefusal, imageMoveRefusal, notAnsweringYet } from "../src/index.js";
import { ROOT, sourceFiles } from "./source-files.js";

interface Call {
  file: string;
  line: number;
  args: string[];
}

/** The arguments of the call whose opening bracket is at `open`, split on the commas that sit at its own depth: a
 * template literal, a nested call and a string holding a comma all stay whole. Returns nothing when the call runs
 * past the end of the file. */
function argsOf(text: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | undefined;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== undefined) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (c === ")" && depth === 0) {
        args.push(text.slice(start, i));
        // A call written over several lines carries a trailing comma, which is no argument.
        return args.at(-1)!.trim() === "" ? args.slice(0, -1) : args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return undefined;
}

/** Every `usageRefusal(` call in the repo's source, its arguments kept whole. The declaration itself is skipped:
 * it is the one place the two halves are joined, not a caller of it. */
function refusalCalls(): Call[] {
  const out: Call[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (let at = text.indexOf("usageRefusal("); at !== -1; at = text.indexOf("usageRefusal(", at + 1)) {
      const before = text.slice(0, at);
      if (/(?:export const|function)\s+$/.test(before)) continue;
      const args = argsOf(text, text.indexOf("(", at));
      if (args === undefined) continue;
      out.push({ file, line: before.split("\n").length, args });
    }
  }
  return out;
}

/** The refusals the app holds as words rather than throwing: a held verb's tooltip, the sentence the command line
 * throws for the same verb, and the move onto a newer image. Each is one sentence, so the two halves meet at a
 * semicolon rather than arriving as two arguments. */
const HELD_REFUSALS = (): ReadonlyArray<string | null> => [
  goneRoadRefusal("running", "rebuild"),
  goneRoadRefusal("paused", "forget"),
  notAnsweringYet("rebuild"),
  notAnsweringYet("forget"),
  goneRefusal("wake"),
  actionRefusal("paused", "import"),
  actionRefusal("waking", "import"),
  actionRefusal("unreachable", "export"),
  agentsKindRefusal("ssh"),
  imageMoveRefusal("api", "running", { knownVersion: false, projectImage: false }),
  imageMoveRefusal("api", "running", { knownVersion: true, projectImage: true }),
  imageMoveRefusal("api", "paused", { knownVersion: true, projectImage: false }),
  imageMoveRefusal("api", "gone", { knownVersion: true, projectImage: false }),
];

describe("every refusal the app holds as words", () => {
  // What that second half says is read here by eye, case by case: a clause continuing one sentence in lower case
  // cannot be checked for the shape of an instruction the way the command line's own fix half can below.
  it("is one sentence in two clauses at a semicolon, both of them said", () => {
    for (const refusal of HELD_REFUSALS()) {
      const halves = (refusal ?? "").split("; ");
      expect([refusal, halves.length > 1 && halves.every(half => half.trim() !== "")]).toEqual([refusal, true]);
    }
  });
});

describe("every refusal the command line can print", () => {
  const calls = refusalCalls();

  it("is written as two halves, both of them said", () => {
    // The walk is only worth anything if it found the refusals: a parser that quietly matched nothing would pass.
    expect(calls.length).toBeGreaterThan(100);
    const oneHalf = calls.filter(c => c.args.length !== 2 || c.args.some(a => a.trim() === "" || a.trim() === '""'));
    expect(oneHalf.map(c => `${c.file}:${c.line}`)).toEqual([]);
  });

  it("says the second half as an instruction of its own, not as more of the fault", () => {
    // A fix half written out here is read here; one built from a name is read where that name is declared.
    const literal = calls.filter(c => /^\s*["'`]/.test(c.args[1] ?? ""));
    expect(literal.length).toBeGreaterThan(40);
    // Either a sentence telling the person what to do, or the line's own usage.
    const notInstructions = literal.filter(c => !/^\s*["'`](?:[A-Z]|usage:)/.test(c.args[1]!));
    expect(notInstructions.map(c => `${c.file}:${c.line}`)).toEqual([]);
  });
});
