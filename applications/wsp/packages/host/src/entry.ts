// SPDX-License-Identifier: AGPL-3.0-only
// What a wsp executable does at start, shared by the npm bin and the command
// the desktop app bundles: quiet node's own line about node:sqlite, run the
// command line, turn its answer into an exit code, and take away anything the
// command stood up that would otherwise keep this process here.
import { verbFailure } from "@wsp/protocol";
import { cli } from "./cli.js";
import { closeStandInGuests } from "./fake-guest.js";
import type { RunningWsp } from "./mcp-install.js";

/** A warning listener cannot veto node's own printer, so the printer is wrapped; a --disable-warning flag on the
 * shebang misses every launch that runs `node bin.js`, and node:sqlite is loaded lazily. */
function quietSqliteWarning(): void {
  for (const print of process.listeners("warning")) {
    process.removeListener("warning", print);
    process.on("warning", w => {
      if (w.name === "ExperimentalWarning" && w.message.startsWith("SQLite ")) return;
      print(w);
    });
  }
}

/** Runs the command line in this process and sets its exit code; `run` is how this process was started, for the
 * MCP install to write into an agent's config. */
export function runBin(argv: string[], run?: RunningWsp): void {
  quietSqliteWarning();
  // A command that serves never returns here, so the close below runs only once a command's work is done: the
  // daemons a stand-in provider's machines were given are listening sockets, and a verb that dialled one printed
  // its whole answer and then sat at a prompt that never came back.
  cli(argv, undefined, run).then(
    async code => {
      await closeStandInGuests();
      process.exitCode = code;
    },
    async (e: unknown) => {
      await closeStandInGuests();
      const failure = verbFailure(e);
      console.error(failure.error);
      process.exitCode = failure.exit;
    },
  );
}
