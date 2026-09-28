// SPDX-License-Identifier: AGPL-3.0-only
// The daemon binary staged beside this command is the one the host on this
// computer spawns for its own workspace and runs the copy verb from, and no
// node build makes it: a rebuild that left it behind runs beside whatever was
// there before, whose verbs are not this wsp's. This starts the staged binary
// the way the host starts it and reads the version it answers with against the
// one this wsp deploys. Skipped with the reason where no binary is staged,
// which is a fresh checkout; required where the build staged one, which is CI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_VERSION } from "@wsp/protocol";
import { REQUIRE_DAEMON_ENV } from "@wsp/host";
import { daemonBinaryHere } from "../../host/src/assets.js";
import { LocalDaemon } from "../../host/src/local-daemon.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Why this case did not run, or nothing when it can: a platform wsp builds no daemon for, and a checkout whose
 * daemon folder no cargo build and no release has filled. Read through the host's own reader, so the file this
 * case looks for is the one the host would spawn. */
function noBinary(): string | undefined {
  try {
    daemonBinaryHere();
    return undefined;
  } catch {
    return `no daemon staged for ${process.platform} ${process.arch}; the landing gate on this Mac has none`;
  }
}

describe("the daemon staged beside this command", () => {
  it("answers the version this wsp deploys, so a host rebuilt without it is caught here and not by a person", async () => {
    const why = noBinary();
    if (why !== undefined) {
      // Required where the build staged the binary, which is CI: a quiet skip there would let a stale asset ship.
      if (process.env[REQUIRE_DAEMON_ENV] === "1") throw new Error(why);
      expect(why).toContain(process.platform);
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "wsp-staged-daemon-"));
    made.push(root);
    const daemon = await LocalDaemon.start({ root, workFolder: root, rootsPath: join(root, "roots"), inboxDir: join(root, "inbox") });
    try {
      expect(daemon.version).toBe(DAEMON_VERSION);
    } finally {
      await daemon.close();
    }
  }, 30_000);
});
