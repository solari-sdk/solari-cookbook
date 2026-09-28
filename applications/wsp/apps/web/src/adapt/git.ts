// SPDX-License-Identifier: AGPL-3.0-only
// What a failed git.status says about the folder: the daemon's not-a-git-repo
// code means the folder sits outside any repository; every other failure, a
// coded refusal or a dropped wire among them, is a read the machine refused
// and says so. The blank slot is the read that has not answered yet, which is
// the state the caller starts in and asks again out of once the link is up.
import type { DaemonErrorCode } from "@wsp/protocol";

const NOT_A_GIT_REPO: DaemonErrorCode = "not-a-git-repo";

export function repoAbsence(e: unknown): "none" | "refused" {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return code === NOT_A_GIT_REPO ? "none" : "refused";
}
