// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenManifest } from "@wsp/runtime";

/** One sealed version at head: the least a state file holds once wsp init has run. */
export const SEALED_GOLDEN: GoldenManifest = {
  head: 1,
  versions: [
    {
      version: 1,
      snapshotId: "snap_gold",
      baseTemplate: "base",
      setupSha: "x",
      createdAt: "2026-09-01T00:00:00Z",
      smoke: { cmd: "true", exitCode: 0 },
    },
  ],
};
