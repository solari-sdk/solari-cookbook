// SPDX-License-Identifier: AGPL-3.0-only
// What a machine that already existed says about itself: the system it runs
// and how long it has been up. The answers are the same wherever the machine
// is, so the lines that ask for them and the readings of what came back live
// here once and the kinds that reach a machine call them: this computer runs
// them in a shell of its own, a machine over ssh carries them over the
// connection. Everything here is one shell's worth of printf, since the only
// road every kind has to a machine is a command.

import type { ExecResult } from "./machine.js";

/** `key value` lines to a record, which is the shape every read here prints in: one answer per line, the key up to
 * the first space. A key whose command printed nothing is present and empty, which the readings below take as an
 * answer the machine does not have rather than as a value. */
export function readValues(stdout: string): Record<string, string> {
  return Object.fromEntries([...readLists(stdout)].map(([key, values]) => [key, values.at(-1)!]));
}

/** The same lines with a key that repeats (ssh -G's identityfile) keeping every value in order. */
export function readLists(stdout: string): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space);
    lists.set(key, [...(lists.get(key) ?? []), line.slice(space + 1).trim()]);
  }
  return lists;
}

/** The lines that ask a machine what system it runs: the distribution's own name where the machine keeps one, the
 * product version where the maker is Apple, and the kernel with its release, which every unix answers whatever else
 * it has. Each is a printf of its own, so a machine missing one of the three still answers for the others. */
export const OS_READ: readonly string[] = [
  `printf "pretty %s\\n" "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -1 | tr -d '"')"`,
  `printf "mac %s\\n" "$(sw_vers -productVersion 2>/dev/null)"`,
  `printf "kernel %s %s\\n" "$(uname -s)" "$(uname -r)"`,
];

/** The lines that ask how long the machine has been up: the seconds Linux keeps in /proc, and the moment macOS says
 * it booted at, which is a time and not a length. */
export const UPTIME_READ: readonly string[] = [
  `printf "uptime %s\\n" "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
  `printf "boot %s\\n" "$(sysctl -n kern.boottime 2>/dev/null)"`,
];

/** The line that asks where the machine's login lands, which on a machine somebody owns is the folder a command
 * starts in: the read that records a workspace and the read behind its rows both ask for it this way. */
export const HOME_READ = `printf "home %s\\n" "$HOME"`;

/** The line that asks what system the machine runs, read before the chip: a Mac's arm64 and x86_64 are chip words
 * a Linux box prints too, and only this says which of the two computers answered. */
export const SYSTEM_READ = `printf "system %s\\n" "$(uname -s)"`;

/** The line that asks what chip the machine runs on. Every binary wsp puts on a machine is built for one, and this
 * is the only word the machine itself uses for it, so what is sent there is picked off this and never off the chip
 * of the computer doing the sending. */
export const ARCH_READ = `printf "arch %s\\n" "$(uname -m)"`;

/** The line that asks the machine's memory in kB, the guest's own count rather than what its provider was asked for. */
export const MEM_READ = 'printf "memkb %s\\n" "$(awk \'/MemTotal/{print $2}\' /proc/meminfo 2>/dev/null || echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 )))"';

/** The lines that ask which login shell this login runs, by its name alone. The passwd entry is the truth and
 * getent runs no shell of the machine's, which is what lets the question be asked before anything is run in that
 * shell. Behind it `$SHELL`, which is the same truth by another road: sshd sets it to the login's shell for every
 * session it opens, and bash fills it from the passwd database where it was unset, so a machine carrying no getent
 * still names its own shell rather than a word this end guessed. Behind that bash, which is what every reader then
 * takes the answer for. Left in `shell` for the line after it to print in whichever shape its own read speaks. */
export const SHELL_READ = 'shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7); shell=${shell##*/}; shell=${shell:-${SHELL##*/}}; shell=${shell:-bash}';

/** What the machine said its chip is, or nothing where it answered none; the word is the machine's own and is
 * matched against a table rather than read apart here. */
export function archOf(values: Record<string, string>): string | undefined {
  const arch = values["arch"];
  return arch === undefined || arch === "" ? undefined : arch;
}

/** What the machine said its system is, in uname's own word, or nothing where it answered none. */
export function systemOf(values: Record<string, string>): string | undefined {
  const system = values["system"];
  return system === undefined || system === "" ? undefined : system;
}

/** What the machine said its memory is, in whole MB, or nothing where the line printed no figure. */
export function memMbOf(values: Record<string, string>): number | undefined {
  const kb = Number(values["memkb"]);
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined;
}

/** The operating system as its maker names it: macOS by its product version, a Linux by its distribution's own
 * name, and the kernel where neither answered. Absent where the machine answered none of the three, which is a
 * machine that did not run the lines rather than one without a name. */
export function osNameOf(values: Record<string, string>): string | undefined {
  const mac = values["mac"];
  if (mac !== undefined && mac !== "") return `macOS ${mac}`;
  const pretty = values["pretty"];
  if (pretty !== undefined && pretty !== "") return pretty;
  const kernel = values["kernel"];
  return kernel === undefined || kernel === "" ? undefined : kernel;
}

/** How long the machine has been up, in ms. Linux says it directly; macOS says when it booted, so the length is
 * worked out against the clock of the computer wsp runs on rather than the machine's own, so a machine whose clock
 * differs from this one carries that difference into the row. At days and hours it does not show, and the machine
 * offers no second reading to check it against. */
export function uptimeMsOf(values: Record<string, string>, now: number): number | undefined {
  const secs = Number(values["uptime"]);
  if (values["uptime"] !== undefined && values["uptime"] !== "" && Number.isFinite(secs)) return Math.round(secs * 1_000);
  const boot = /sec = (\d+)/.exec(values["boot"] ?? "")?.[1];
  return boot === undefined ? undefined : Math.max(0, now - Number(boot) * 1_000);
}

/** One command on a machine for the name of the system it runs; absent where the command failed or the machine
 * answered nothing, which leaves the caller to say what it knows without it. */
export async function readOsName(exec: (cmd: string) => Promise<ExecResult>): Promise<string | undefined> {
  const res = await exec(OS_READ.join("\n")).catch(() => undefined);
  return res === undefined || res.exitCode !== 0 ? undefined : osNameOf(readValues(res.stdout));
}
