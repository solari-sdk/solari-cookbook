// SPDX-License-Identifier: AGPL-3.0-only
// The command line kind of a guest session: the host's own command line, run
// in this process on the line a guest typed, with what it printed streamed back
// piece by piece and its code at the end.
//
// Three walls hold it, all before anything is parsed, and all read the line the
// way the command line itself reads it: the shared flags lifted off first, then
// the verb found in what is left. Only a word the verb table serves as a tool
// passes, so a line that belongs at the person's own keyboard is answered with
// one sentence and reaches nothing. A verb whose work is on the computer the
// process runs on is refused with it, since here that computer is the person's
// and the line asked about the machine it was typed on. And a line may not aim
// itself, so --host and --state are refused rather than read, and only where
// the words are the line's own rather than the command it runs in the
// workspace. Past those, every op the line makes enters this host through the
// socket door under the thread's own token, and every rule that would read a
// path or a folder here reads `elsewhere` off the verb deps and refuses: a path
// this line names is on its own machine.
import { guestHostFlagLine, guestPersonsComputerLine } from "@wsp/protocol";
import { cli, type CliIO } from "./cli.js";
import type { GuestKindModule, GuestOpening } from "@wsp/runtime";
import type { RunningWsp } from "./mcp-install.js";
import { findVerb, hasTool, readsHere, takeCommon } from "./verbs.js";

/** The two flags that would aim a line somewhere other than the host that launched the turn. */
const AIMING_FLAGS = ["--host", "--state"];
/** The flag every page is asked for by, and the two spellings it has. A line carrying it prints a page and runs
 * nothing, whatever word follows, so it passes whatever that word is. */
const HELP_FLAGS = ["--help", "-h"];
/** The two words that name no verb and still run nothing but an answer about this command line itself: the pages,
 * and the version, which is read before any word on the line selects anything. */
const ASKS_WHAT_THIS_IS = ["help", "--version", "-v"];

/** Why a line is refused before it runs, or nothing when it may run. */
export function guestRefusal(argv: readonly string[]): string | undefined {
  // Only the line's own words: from `--` on they belong to the command the line runs in the workspace, where
  // --host is somebody else's flag and this host has no say over it.
  const cut = argv.indexOf("--");
  const own = cut === -1 ? argv : argv.slice(0, cut);
  if (own.some(word => AIMING_FLAGS.some(flag => word === flag || word.startsWith(`${flag}=`)))) return guestHostFlagLine;
  // The verb is looked for in the words left after the shared flags are lifted off, because that is what the
  // command line does before it looks for one. Reading the first word of the line as typed instead let a line that
  // led with --json past both walls and ran whatever followed it.
  const { common, rest } = takeCommon(own);
  if (common.some(word => HELP_FLAGS.includes(word))) return undefined;
  const word = rest[0];
  if (word === undefined || ASKS_WHAT_THIS_IS.includes(word)) return undefined;
  const verb = findVerb(rest);
  // A word no verb of the table opens is a line of the plumbing's or the person's own: up, init, mcp, host.
  if (verb === undefined) return guestPersonsComputerLine(word);
  // A verb the command line alone serves, and one whose work is on the computer the process runs on: inside a
  // machine that computer is the person's, so the line would answer about theirs and not about this machine.
  return hasTool(verb) && readsHere(verb) === undefined ? undefined : guestPersonsComputerLine(verb.name);
}

export function guestCli(statePath: string, run: RunningWsp): GuestKindModule {
  return {
    open(o) {
      void runLine(o, run).catch((e: unknown) => o.close(e instanceof Error ? e.message : String(e)));
      // A line runs to its end; the guest's socket going is what the door drops, and the streams stop reaching it.
      return { message: () => undefined, close: () => undefined };
    },
  };
}

async function runLine(o: GuestOpening, run: RunningWsp): Promise<void> {
  const refusal = guestRefusal(o.argv);
  if (refusal !== undefined) {
    o.reply({ stream: "err", text: `${refusal}\n` });
    o.reply({ exit: 1 });
    o.close();
    return;
  }
  const io: CliIO = {
    log: line => o.reply({ stream: "out", text: `${line}\n` }),
    error: line => o.reply({ stream: "err", text: `${line}\n` }),
    stream: text => o.reply({ stream: "err", text }),
    // Nobody is at a keyboard inside a machine: every question takes the answer a pipe would give it.
    ask: async () => "no",
    askSecret: async () => "",
  };
  // No starter: a line from a machine never brings a host up on this computer, it runs against the one that
  // launched its turn.
  const code = await cli([...o.argv], io, run, o.env, false, { cwd: o.cwd, elsewhere: true });
  o.reply({ exit: code });
  o.close();
}
