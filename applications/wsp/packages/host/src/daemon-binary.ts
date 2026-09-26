// SPDX-License-Identifier: AGPL-3.0-only
// Where a wsp-daemon binary sits and which row of the engine's target table a
// machine takes, off what node or the machine itself says it is.
import { join } from "node:path";
import { DAEMON_TARGETS, type DaemonTarget } from "@wsp/engine";

export { DAEMON_TARGETS, type DaemonTarget };

/** The targets a guest can be: every Linux row. A bundle carries all of them where the host has not read the
 * machine's own word for its chip, which is every fork of an image, since nothing answers there until the daemon
 * does, and the deploy drops the ones the machine is not; the ssh roads read the chip off the machine first and
 * carry the one row it names. */
export const GUEST_DAEMON_TARGETS: readonly DaemonTarget[] = DAEMON_TARGETS.filter(t => t.platform === "linux");

/** The binary's name, on every machine and in every folder that carries one. */
export const DAEMON_BIN = "wsp-daemon";

/** The row for a machine that says it is this platform and this chip, in node's own words for both, or nothing
 * where wsp builds no daemon for it. What a place's report is read through, since a place is another computer. */
export function daemonTargetFor(platform: string, arch: string): DaemonTarget | undefined {
  return DAEMON_TARGETS.find(t => t.platform === platform && t.arch === arch);
}

/** The row for the machine this process runs on, or nothing on a platform wsp builds no daemon for. */
export function daemonTargetHere(): DaemonTarget | undefined {
  return daemonTargetFor(process.platform, process.arch);
}

/** Where a target's binary sits inside the daemon asset. */
export function daemonBinaryIn(dir: string, triple: string): string {
  return join(dir, triple, DAEMON_BIN);
}

/** The name the release workflow uploads a target's binary under, as an artifact and as a release asset. */
export const daemonArtifactName = (triple: string): string => `${DAEMON_BIN}-${triple}`;

export const noDaemonBuildLine = (platform: string, arch: string): string =>
  `wsp builds no daemon for ${platform} ${arch}, so this computer cannot serve its own workspace or join a wsp as a place`;

/** The row a machine's own `uname -s` and `uname -m` name, out of the targets a guest can be. The one mapping from
 * what a box says about itself to the binary it is sent, so nothing picks that binary off the computer doing the
 * sending. A box that named no system is matched on its chip alone. Nothing for a system or chip no guest row has. */
export function guestDaemonTarget(system: string | undefined, uname: string): DaemonTarget | undefined {
  const said = uname.trim();
  return GUEST_DAEMON_TARGETS.find(t => (system === undefined || t.system === system) && t.uname === said);
}

/** Whether a guest row runs the system a machine named: a box that named none is left to its chip. */
export const guestSystem = (system: string | undefined): boolean => system === undefined || GUEST_DAEMON_TARGETS.some(t => t.system === system);

/** The refusal for a computer whose system no guest row runs, said before its chip: named by its own row where wsp
 * builds a daemon for that system at all, by uname's word where it builds none. `joined` is a computer already in
 * the wsp, which an update reaches. */
export function noPlaceSystemLine(system: string, who = "that computer", joined = false): string {
  const place = `wsp ${joined ? "keeps" : "joins"} only a ${[...new Set(GUEST_DAEMON_TARGETS.map(t => t.computer))].join(" or a ")} as a place`;
  const row = DAEMON_TARGETS.find(t => t.system === system);
  if (row === undefined) return `${who} runs ${system}, and ${place}`;
  return `${who} is a ${row.computer}, and ${place}; a ${row.computer} cannot ${joined ? "be updated as one" : "join yet"}`;
}

/** The refusal for a box whose chip wsp builds no daemon for, said before a byte of wsp's lands on it. */
export const noGuestDaemonLine = (uname: string): string =>
  `that computer says its chip is ${uname}, and wsp builds no daemon for it; wsp joins a computer running ${GUEST_DAEMON_TARGETS.map(t => t.uname).join(" or ")}`;
