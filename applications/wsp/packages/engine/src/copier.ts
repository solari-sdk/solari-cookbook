// SPDX-License-Identifier: AGPL-3.0-only
// How a workspace on the computer somebody sits at gets its copy of the project
// folder: the daemon binary's own copy verb, run as a child of this host with
// argv and answering one JSON line. Node has no directory clone, and a per-file
// clone of a six gigabyte checkout was measured at 27.6 s against 4.9 s for one
// clonefile call on the directory, which is why the copy lives in the daemon's
// code and this module is the road to it. One interface, the real road and the
// stand-in tests drive, so nothing above here knows there is a child process.
import { copyVerbFailedLine, CopyReport, type CopyAsk, type CopyRoad } from "@wsp/protocol";
import { runChild } from "./child-exec.js";

export interface Copier {
  /** Makes the copy and answers what the verb reported; throws the verb's own sentence when it refused. */
  make(ask: CopyAsk): Promise<CopyReport>;
  /** Takes a copy away by the road that made it, which is the road the record carries. */
  remove(from: string, to: string, road: CopyRoad): Promise<void>;
}

/** How long one copy has. A six gigabyte checkout clones in about five seconds and a worktree of one writes every
 * tracked file, so the bound is generous: what it is here for is a git call wedged on a lock, never a slow disk. */
export const COPY_TIMEOUT_MS = 10 * 60_000;

const argvFor = (ask: CopyAsk): string[] => [
  "copy",
  "make",
  "--from",
  ask.from,
  "--to",
  ask.to,
  ...(ask.base !== undefined ? ["--base", ask.base] : []),
  ...ask.exclude.flatMap(dir => ["--exclude", dir]),
  "--size-line-bytes",
  String(ask.sizeLineBytes),
  ...(ask.road !== undefined ? ["--road", ask.road] : []),
];

/** The daemon binary's verb as a child of this host: argv, never a shell line, so a folder with a space or a
 * quote in its name is one word. The refusal a person reads is the verb's own last line on the exit the verb
 * documents for a refusal, exit 1, since the verb knows why it could not copy and this side would only be
 * guessing. Every other exit is a failure the verb never worded: a parse error exits 2 and prints its whole usage
 * text, and a killed child exits on a signal with nothing at all, neither of which is a sentence about a copy. */
export function verbCopier(binary: string, run: typeof runChild = runChild): Copier {
  const line = (res: { exitCode: number; stderr: string; stdout: string }): string => {
    const said = res.stderr.trim() || res.stdout.trim();
    if (res.exitCode !== 1) {
      // The output goes to the host's log, where somebody looking at a copy that failed can read it, and never to
      // the person, who asked for a workspace and not for a program's usage.
      if (said !== "") console.warn(`${binary} copy: ${said}`);
      return copyVerbFailedLine(res.exitCode);
    }
    return said.split("\n").at(-1) ?? "the copy failed and said nothing";
  };
  return {
    async make(ask) {
      const res = await run(binary, argvFor(ask), { timeoutMs: COPY_TIMEOUT_MS });
      if (res.exitCode !== 0) throw new Error(line(res));
      const said = res.stdout.trim();
      // Its own sentence for a line that is not the report, since a JSON parser's is about a character offset and
      // says nothing about a copy: a verb killed at its deadline prints nothing at all and would otherwise reach a
      // person as "unexpected end of input".
      const printed: unknown = ((): unknown => {
        try {
          return JSON.parse(said);
        } catch {
          return undefined;
        }
      })();
      const parsed = CopyReport.safeParse(printed);
      if (!parsed.success) throw new Error(`the copy verb answered something this host does not read: ${said.slice(0, 200) || "nothing at all"}`);
      return parsed.data;
    },
    async remove(from, to, road) {
      const res = await run(binary, ["copy", "remove", "--from", from, "--to", to, "--road", road], { timeoutMs: COPY_TIMEOUT_MS });
      if (res.exitCode !== 0) throw new Error(line(res));
    },
  };
}

/** The stand-in every test above the daemon drives: it records what it was asked for and answers a report of the
 * road it was told to take, so the rules a copy stands on are proved once in the daemon's own tests and the roads
 * above it are proved against what a copy answers. */
export function fakeCopier(script?: (ask: CopyAsk) => CopyReport): Copier & { asks: CopyAsk[]; removed: { from: string; to: string; road: CopyRoad }[] } {
  const asks: CopyAsk[] = [];
  const removed: { from: string; to: string; road: CopyRoad }[] = [];
  return {
    asks,
    removed,
    async make(ask) {
      asks.push(ask);
      return (
        script?.(ask) ?? {
          road: ask.road ?? "clonefile",
          path: ask.to,
          base: "0".repeat(40),
          branch: "main",
          fetched: true,
          carried: "deps-and-config",
          excluded: [...ask.exclude],
          bytes: 1024,
          ms: 1,
        }
      );
    },
    async remove(from, to, road) {
      removed.push({ from, to, road });
    },
  };
}
