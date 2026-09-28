// SPDX-License-Identifier: AGPL-3.0-only
// Which home a line on this computer works on: the one WSP_HOME names, or
// this computer's own. One reading, since the command line here, the desktop
// and the probe a box answers over ssh must not disagree about where the host
// is. A home somebody moved is named by whoever wants it, with --state or
// WSP_HOME, and no host writes a file under the person's home to say where it
// went: two hosts on two state files would then share that one file.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { servingHost } from "./host-lock.js";

/** The folder wsp keeps a person's things in when nobody names another, under the home directory it is given. */
export const defaultHomeIn = (user: string): string => join(user, ".wsp");

/** The home WSP_HOME names, or nothing: unset and empty are one answer, and every road that reads the variable
 * reads it here. */
export const homeNamed = (value: string | undefined): string | undefined => (value !== undefined && value !== "" ? value : undefined);

/** The home a line works on when it names none: WSP_HOME when it names one, else this computer's default. */
export function servingHome(env: Readonly<Record<string, string | undefined>> = process.env, user: string = homedir()): string {
  return homeNamed(env["WSP_HOME"]) ?? defaultHomeIn(user);
}

/** A path as the file system knows it, so one folder reached by two names (/tmp and /private/tmp on a Mac) is not
 * read as two states. Where nothing has made the file or its folder yet, the path as written is all there is. */
export function realState(path: string): string {
  const dir = dirname(path);
  if (existsSync(path)) return realpathSync(path);
  return existsSync(dir) ? join(realpathSync(dir), basename(path)) : path;
}

/** The state file a host on this computer is serving, when that is not the one a line works on. A line typed in a
 * folder carrying a `.wsp` of its own works on that folder's state, and nothing in the line says the host this
 * computer serves is another one; whoever names the difference names this path. The two are compared as the file
 * system knows them, so a state folder reached through a symlink is not read as a second state. */
export function servingElsewhere(statePath: string, env: Readonly<Record<string, string | undefined>> = process.env, user: string = homedir()): string | undefined {
  const served = join(servingHome(env, user), "state.json");
  return realState(served) !== realState(statePath) && servingHost(served) !== undefined ? served : undefined;
}

/** The same reading in POSIX sh, for a box answering over ssh before any wsp of its own has run: it leaves $home
 * naming the home a line there works on, and wsp_serving able to say whether a home has a host. The two spellings
 * sit in one file and one test holds them to the same answer on the same folders. A pid living under another user
 * reads as alive to the reading above and as gone to this one, which is as far as kill -0 says in a shell; a host
 * under another login is not one this login could pair with anyway. */
export const SERVING_HOME_SH = [
  'wsp_serving() { [ -f "$1/host.lock" ] || return 1; pid=$(sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' "$1/host.lock"); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }',
  'home="${WSP_HOME:-$HOME/.wsp}"',
].join("\n");
