// SPDX-License-Identifier: AGPL-3.0-only
// What the system package manager has that a person chose themselves. On a
// Linux computer this is the only reader for most of what they installed:
// direnv, fish and starship come by apt where a Mac gets them from Homebrew.
// Telling a person's choice from the distro's own is the whole job. Measured
// on Ubuntu 24.04: 341 packages installed, 116 marked manual, and most of the
// 116 are the base image. Three steps cut it to the handful somebody typed,
// and the packages an installer marks manual that nobody picks are named here
// rather than guessed at. Everything runs read-only: apt-mark, dpkg-query and
// dpkg's own records, never apt-get, never root.
import type { Host } from "../host.js";
import type { Pkg } from "./tools.js";

/** Where dpkg keeps what each package installed. */
const DPKG_INFO = "/var/lib/dpkg/info";

/** The priorities a person's own choice has: everything the distro needs to boot and run is required, important or
 * standard, and no package a person installs by hand lands there. */
const CHOSEN = new Set(["optional", "extra"]);

/** Packages marked manual that nobody chose: what Ubuntu's own installer and cloud images leave behind. Named,
 * since no rule over priorities or files tells them from a tool somebody typed. */
const NOT_A_CHOICE = new Set(["sudo", "unminimize", "lsb-release", "apt-transport-https"]);

/** A path that is a command a person would type: a file directly under /usr/bin or /bin. A library, a font or a
 * documentation package ships none, and is nothing to install on the machine. */
const COMMAND_PATH = /^\/(usr\/)?bin\/[^/]+$/;

/** `<package> <field>` lines as dpkg-query writes them, by package; a line naming no value says nothing and is
 * dropped. A package installed for two architectures is one entry, since `${Package}` carries no architecture. */
export function parseDpkgFields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s*$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    out.set(m[1], m[2]);
  }
  return out;
}

/** The names `apt-mark showmanual` answers with, in its own order. */
export function parseAptManual(text: string): string[] {
  return text.split("\n").map(l => l.trim()).filter(l => l !== "");
}

/** Every installed package's file list by package name: dpkg names the file `<pkg>.list`, or `<pkg>:<arch>.list`
 * for a package installed for a named architecture. One directory read, since a `dpkg -L` per candidate is a
 * process per candidate. */
async function fileLists(host: Host): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await host.fs.list(DPKG_INFO)) {
    if (!name.endsWith(".list")) continue;
    const pkg = name.slice(0, -".list".length).split(":")[0];
    if (pkg !== undefined && pkg !== "") out.set(pkg, `${DPKG_INFO}/${name}`);
  }
  return out;
}

/** Whether the package put a command on PATH, read from dpkg's list for it one line at a time; a package dpkg has
 * no list for says nothing about itself and is left out. */
async function shipsCommand(host: Host, file: string | undefined): Promise<boolean> {
  if (file === undefined) return false;
  for await (const line of host.fs.lines(file)) if (COMMAND_PATH.test(line.trim())) return true;
  return false;
}

/** The apt packages this computer's owner chose: marked manual, of a priority the distro does not need, and
 * shipping a command. What the catalog or another rung already carries is dropped by whoever asked, so both
 * callers read one list. The caller has already found apt-mark on PATH. */
export async function aptPackages(host: Host): Promise<Pkg[]> {
  const manual = parseAptManual((await host.exec.run("apt-mark", ["showmanual"])) ?? "");
  const mine = manual.filter(name => !NOT_A_CHOICE.has(name));
  if (mine.length === 0) return [];
  const priority = parseDpkgFields((await host.exec.run("dpkg-query", ["-Wf", "${Package} ${Priority}\n"])) ?? "");
  const lists = await fileLists(host);
  const out: Pkg[] = [];
  for (const name of mine.filter(n => CHOSEN.has(priority.get(n) ?? ""))) {
    if (await shipsCommand(host, lists.get(name))) out.push({ name });
  }
  return out;
}

/** What each of these packages takes on this computer, from dpkg's own record: its Installed-Size is kibibytes, as
 * `du -sk` is for the other managers. One run for all of them, and none when nothing needs a size. */
export async function aptSizes(host: Host, names: readonly string[]): Promise<Map<string, number>> {
  if (names.length === 0) return new Map();
  const fields = parseDpkgFields((await host.exec.run("dpkg-query", ["-Wf", "${Package} ${Installed-Size}\n"])) ?? "");
  const out = new Map<string, number>();
  for (const name of names) {
    const kib = Number(fields.get(name));
    if (Number.isFinite(kib) && kib > 0) out.set(name, kib * 1024);
  }
  return out;
}
