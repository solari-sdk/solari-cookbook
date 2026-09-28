// SPDX-License-Identifier: AGPL-3.0-only
// The folders the daemon browses beside its home live in one file on the
// guest, read at every files and diff op. The runtime writes it when a project
// lands, whole and in one rename, so a daemon reading mid-write never sees half.
import { posix } from "node:path";
import { DAEMON_ROOTS_PATH, shellQuote } from "@wsp/protocol";

/** `rootsPath` is where the daemon that reads it looks: the guest constant on a fork, beside the person's home on
 * this computer's own daemon. */
export function writeDaemonRootsScript(roots: readonly string[], rootsPath: string = DAEMON_ROOTS_PATH): string {
  const next = `${rootsPath}.next`;
  return [
    `mkdir -p ${shellQuote(posix.dirname(rootsPath))}`,
    `printf '%s\\n' ${roots.map(shellQuote).join(" ")} > ${shellQuote(next)}`,
    `mv -f ${shellQuote(next)} ${shellQuote(rootsPath)}`,
  ].join("\n");
}
