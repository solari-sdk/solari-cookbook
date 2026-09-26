// SPDX-License-Identifier: AGPL-3.0-only
// Which wsp-daemon binary a machine runs: one row per target wsp builds, in
// the words node, uname and the Rust toolchain each use for it, so the release
// job, the bundle a guest gets, the unit a joined computer installs, the
// daemon this computer spawns and every read of what a machine says it is
// read one table. Adding a target is a row here and a matrix entry in the
// release workflow, whose test holds the two equal.

export interface DaemonTarget {
  /** The Rust target triple: the folder the binary sits in under the daemon asset and the release artifact that carries it. */
  triple: string;
  /** node's own words for the machine that runs it. */
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  /** What `uname -s` prints there, the word a machine names its system by before its chip. */
  system: "Linux" | "Darwin";
  /** What `uname -m` prints there, the one word a deploy script can read a guest's chip off. */
  uname: string;
  /** What a sentence calls a computer of this system. */
  computer: string;
}

export const DAEMON_TARGETS: readonly DaemonTarget[] = [
  { triple: "x86_64-unknown-linux-musl", platform: "linux", arch: "x64", system: "Linux", uname: "x86_64", computer: "Linux computer" },
  { triple: "aarch64-unknown-linux-musl", platform: "linux", arch: "arm64", system: "Linux", uname: "aarch64", computer: "Linux computer" },
  { triple: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", system: "Darwin", uname: "arm64", computer: "Mac" },
  { triple: "x86_64-apple-darwin", platform: "darwin", arch: "x64", system: "Darwin", uname: "x86_64", computer: "Mac" },
];

/** node's word for the system a machine's `uname -s` names, or nothing for a system no row has. */
export function platformOfSystem(system: string): DaemonTarget["platform"] | undefined {
  return DAEMON_TARGETS.find(t => t.system === system)?.platform;
}
