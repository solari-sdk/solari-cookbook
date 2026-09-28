// SPDX-License-Identifier: AGPL-3.0-only
// Which paths under an agent's home on the machine hold one project's state.
// Nothing on the machine can run the engine, so each module emits a python3
// script the machine runs there and the trip pulls only the paths it prints.
// A store the agent keeps for every project is copied there, the project's
// rows alone, and the copy travels in its place. A store the script cannot
// read brings nothing from that home at all: bringing the store, or the tree
// beside it, would carry every other project's rows off the machine, which is
// the one thing the filter exists to stop. The listing names such a store and
// why on its own marked line, so the export can say it in words.
import { join } from "node:path";
import { PY_PREAMBLE, pyData } from "./py.js";
import type { SharedStore } from "./resolver.js";

/** The step that names a module's whole roots: what a home gives up when its module emits no listing of its own. */
export const ROOTS_STEP = ["for r in ROOTS:", "    say(r)"].join("\n");

const indented = (step: string): string[] => step.split("\n").map(l => `    ${l}`);

/** The mark a listing prints an unreadable store on, ahead of the base64 JSON naming it. No absolute path starts with
 * it, so one stdout carries both the paths a trip pulls and the stores it had to leave behind. */
const UNREAD_MARK = "!unread ";

/** A store an agent keeps for every project that the listing on the machine could not read, so nothing from that
 * home travelled: the agent whose home holds it, the store's path there, and what python3 said went wrong. */
export interface UnreadStore {
  agent: string;
  store: string;
  why: string;
}

/** What one listing command printed: the paths a trip pulls, and the stores it could not read. */
export function parseStateListing(stdout: string): { paths: string[]; unread: UnreadStore[] } {
  const paths: string[] = [];
  const unread: UnreadStore[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    if (line.startsWith(UNREAD_MARK)) unread.push(JSON.parse(Buffer.from(line.slice(UNREAD_MARK.length), "base64").toString("utf8")) as UnreadStore);
    else paths.push(line);
  }
  return { paths, unread };
}

/**
 * A listing script from its steps: the shared preamble, then HOME and PATH, say() for a path the trip pulls, unread()
 * for a store this home keeps for every project that will not open, and ROOTS for the module's roots joined onto the
 * home. Both lists are collected and printed at the end, so a step that raises half way leaves the roots behind
 * rather than half a listing.
 */
export function listScript(agent: string, home: string, path: string, roots: readonly string[], steps: readonly string[]): string {
  return [
    PY_PREAMBLE,
    `AGENT = ${pyData(agent)}`,
    `HOME = ${pyData(home)}`,
    // The same spelling resolveProjectPath gives the path here, so the machine and this computer agree on the key.
    `PATH = os.path.normpath(${pyData(path)})`,
    `ROOTS = [os.path.join(HOME, r) for r in ${pyData(roots)}]`,
    "OUT = []",
    "UNREAD = []",
    "def say(p):",
    "    if os.path.exists(p) and p not in OUT:",
    "        OUT.append(p)",
    // Whatever this home said from `said` on is dropped with the half written copy: the store, and the tree beside it,
    // hold every other project's rows, so a read that failed brings nothing rather than all of them.
    "def unread(store, copy, why, said):",
    "    del OUT[said:]",
    "    if os.path.exists(copy):",
    "        os.remove(copy)",
    '    UNREAD.append({"agent": AGENT, "store": store, "why": str(why) or type(why).__name__})',
    "try:",
    ...steps.flatMap(indented),
    "except Exception:",
    "    OUT = []",
    ...indented(ROOTS_STEP),
    "for p in OUT:",
    "    print(p)",
    "for u in UNREAD:",
    `    print(${pyData(UNREAD_MARK)} + base64.b64encode(json.dumps(u).encode("utf-8")).decode("ascii"))`,
  ].join("\n");
}

/**
 * A step naming the directories under `parent` keyed to the project, `key` being a python expression for the key rule
 * the module spells here as keyOf. The key is lossy, so the cwd the directory's first transcript line records decides
 * and a directory with no transcript belongs only when it is the project's own key: the same rule keyedDirectories
 * follows on this computer.
 */
export function keyedStep(parent: string, key: string): string {
  return [
    `PARENT = ${pyData(parent)}`,
    `key = ${key}`,
    "def recorded(d):",
    "    found = []",
    "    for base, _dirs, names in os.walk(d):",
    '        found += [os.path.join(base, n) for n in names if n.endswith(".jsonl")]',
    "    for f in sorted(found):",
    '        with open(f, encoding="utf-8", errors="surrogateescape", newline="") as h:',
    "            for line in h:",
    "                try:",
    "                    obj = json.loads(line)",
    "                except ValueError:",
    "                    continue",
    '                if isinstance(obj, dict) and isinstance(obj.get("cwd"), str):',
    '                    return obj["cwd"]',
    "    return None",
    "own = key(PATH)",
    'other = key(PATH + "/x")',
    "n = 0",
    "while n < len(own) and n < len(other) and own[n] == other[n]:",
    "    n += 1",
    "stem = own[:n]",
    "for name in sorted(os.listdir(PARENT)) if os.path.isdir(PARENT) else []:",
    "    d = os.path.join(PARENT, name)",
    "    if not name.startswith(stem) or not os.path.isdir(d):",
    "        continue",
    "    cwd = recorded(d)",
    "    if cwd is None and name == own:",
    "        cwd = PATH",
    "    if cwd is not None and under(cwd, PATH):",
    "        say(d)",
  ].join("\n");
}

/** Where the filtered copy of a store under `home` is written on the machine: the store's own path under the trip's
 * scratch root, so the archive carries the copy at the path the store has and nothing on this computer needs to know
 * a copy was made. */
export const storeCopy = (scratch: string, home: string, store: string): string => join(scratch, home, store);

/**
 * The step that writes a store's rows for the project into its copy, names the copy and then runs the module's own
 * steps: a copy an earlier trip left is removed first, and a store with no row for the project is not named, so a
 * project no agent ran in still brings nothing. The module's steps read the copy, so they run only once it is
 * written: a home whose store the agent has not made yet brings nothing. A store that will not open, or a step of
 * this home that raises over it, brings nothing from this home either and is named on UNREAD with the reason, so the
 * export says which store it could not read instead of carrying every project in it home.
 */
export function filterStep(scratch: string, home: string, shared: SharedStore, steps: readonly string[]): string {
  const inTry = (step: string): string[] => indented(step).flatMap(indented);
  return [
    `STORE = ${pyData(join(home, shared.store))}`,
    `COPY = ${pyData(storeCopy(scratch, home, shared.store))}`,
    "os.makedirs(os.path.dirname(COPY), exist_ok=True)",
    "if os.path.exists(COPY):",
    "    os.remove(COPY)",
    "FILTERED = 0",
    "if os.path.exists(STORE):",
    "    SAID = len(OUT)",
    "    try:",
    ...shared.filter.flatMap(inTry),
    "        if FILTERED:",
    "            say(COPY)",
    ...steps.flatMap(inTry),
    "    except Exception as e:",
    "        unread(STORE, COPY, e, SAID)",
  ].join("\n");
}
