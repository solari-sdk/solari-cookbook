// SPDX-License-Identifier: AGPL-3.0-only
// Who a line on a computer runs as. A box's daemon runs as root, so a line it
// runs as it is would read root's view of the person's home and write
// root-owned files into it. Every line that reads or writes the agents' files
// on a computer comes through here and runs as the owner of the home instead.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { noHomeRefusal, noRunuserRefusal, shellQuote } from "@wsp/protocol";
import { platformOfSystem } from "./daemon-targets.js";
import { landBytes } from "./land-bytes.js";
import type { Machine } from "./machine.js";

/** The login a computer's lines run as: its home and PATH, the owner of that home, and, where the road runs lines as
 * root and the home is somebody else's, the user every line is handed to. */
export interface TargetLogin {
  platform: "darwin" | "linux";
  home: string;
  path?: string;
  user: string;
  runAs?: string;
}

const PROBE_MS = 20_000;

/** The one read of who a computer's lines run as. `given` is the home and PATH the computer reported for its
 * login, which win over what the road's own shell has, since a box's daemon runs with root's. Refuses where the
 * road is root, the home is somebody else's and there is no runuser to hand the lines to: a line run as root there
 * is a root-owned file in that person's home. A root road whose home is not there is refused too, since it has no
 * owner to hand the lines to. */
export async function targetLogin(machine: Pick<Machine, "exec">, given: { HOME?: string; PATH?: string } = {}): Promise<TargetLogin> {
  const home = given.HOME === undefined ? '"$HOME"' : shellQuote(given.HOME);
  const probe = [
    "uname -s",
    "id -u",
    "id -un",
    // -L: a home that is a link is the folder behind it, whose owner the lines are for, not whoever made the link.
    `stat -L -c %U ${home} 2>/dev/null || stat -L -f %Su ${home} 2>/dev/null || echo`,
    "command -v runuser >/dev/null 2>&1 && echo 1 || echo 0",
    `printf '%s\\n' "$HOME" "$PATH"`,
  ].join("; ");
  const res = await machine.exec(probe, { timeoutMs: PROBE_MS });
  if (res.exitCode !== 0) throw new Error(`the computer did not say who its lines run as: ${(res.stderr || res.stdout).trim().split("\n")[0] ?? ""}`);
  const [os = "", uid = "", self = "", owner = "", runuser = "", shellHome = "", shellPath = ""] = res.stdout.split("\n").map(l => l.trim());
  const platform: TargetLogin["platform"] = platformOfSystem(os) ?? "linux";
  const user = owner === "" ? self : owner;
  const path = given.PATH ?? shellPath;
  const at: TargetLogin = { platform, home: given.HOME ?? shellHome, ...(path !== "" ? { path } : {}), user };
  if (platform !== "linux" || uid !== "0") return at;
  if (owner === "") throw new Error(noHomeRefusal(at.home));
  if (user === "root") return at;
  if (runuser !== "1") throw new Error(noRunuserRefusal(user));
  return { ...at, runAs: user };
}

/** The line as that login runs it: its HOME and PATH exported, in its home, and handed to the home's owner where
 * the road runs as root. `bash -c`, never a login shell, which would reset the PATH. */
export function asLogin(t: TargetLogin, line: string): string {
  const inner = `export HOME=${shellQuote(t.home)}${t.path !== undefined ? ` PATH=${shellQuote(t.path)}` : ""}; cd "$HOME" 2>/dev/null; ${line}`;
  return t.runAs === undefined ? inner : `runuser -u ${shellQuote(t.runAs)} -- bash -c ${shellQuote(inner)}`;
}

const firstLine = (r: { exitCode: number; stdout: string; stderr: string }): string => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.exitCode}`;

/** Lands bytes for that login and hands `use` the staged file's path and its folder's: the bytes land by the
 * machine's own road, which may run as root, in a folder made private before a byte lands; only then, where the road
 * is root, is the folder handed to the login with the file inside, so root never writes by name into a folder the
 * login could have put a link in. The folder goes whatever happened, and a folder this call did not make is never
 * taken. `what` names the bytes in a refusal. */
export async function stageAsLogin<T>(
  machine: Pick<Machine, "exec">,
  land: Pick<Machine, "id" | "putBytes" | "uploadUrl">,
  t: TargetLogin,
  what: string,
  bytes: Uint8Array,
  use: (file: string, folder: string) => Promise<T>,
  o: { timeoutMs?: number } = {},
): Promise<T> {
  const dir = `/tmp/wsp-land-${randomBytes(6).toString("hex")}`;
  const folder = shellQuote(dir);
  const file = `${dir}/bytes`;
  const bound = o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {};
  const made = await machine.exec(`mkdir -m 0700 ${folder}`, bound);
  if (made.exitCode !== 0) throw new Error(`no private folder to stage ${what} in: ${firstLine(made)}`);
  try {
    await landBytes(land, file, bytes, bound);
    const handed = await machine.exec(`chmod 0600 ${shellQuote(file)}${t.runAs !== undefined ? ` && chown -R -- ${shellQuote(t.runAs)} ${folder}` : ""}`, bound);
    if (handed.exitCode !== 0) throw new Error(`the staging folder for ${what} could not be handed to ${t.user}: ${firstLine(handed)}`);
    return await use(file, dir);
  } finally {
    await machine.exec(`rm -rf -- ${folder}`, bound).catch(() => undefined);
  }
}

/** Puts bytes at `dest` as that login, staged as stageAsLogin stages them, by one line as the login that writes them
 * where they go, so the file is the login's and a file already there keeps its mode. `unpack` takes the bytes as a
 * gzipped tarball unpacked into the folder `dest`. */
export async function landAsLogin(machine: Machine, t: TargetLogin, dest: string, bytes: Uint8Array, o: { unpack?: boolean; timeoutMs?: number } = {}): Promise<void> {
  const bound = o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {};
  await stageAsLogin(machine, machine, t, dest, bytes, async file => {
    const at = shellQuote(file);
    const to = shellQuote(dest);
    const put = o.unpack === true ? `mkdir -p ${to} && tar -xzf ${at} -C ${to}` : `mkdir -p ${shellQuote(posix.dirname(dest))} && cat ${at} > ${to}`;
    const res = await machine.exec(asLogin(t, put), bound);
    if (res.exitCode !== 0) throw new Error(`${dest} was not written as ${t.user}: ${firstLine(res)}`);
  }, bound);
}
