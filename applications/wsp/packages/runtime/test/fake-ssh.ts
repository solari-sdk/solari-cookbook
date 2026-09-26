// SPDX-License-Identifier: AGPL-3.0-only
// The ssh client a test dials with: it never leaves this computer, so a road
// that records or drives a machine over ssh is proved against the real
// SshBackend and the real address rules with nothing on the network. One home
// for it, read by the runtime's own tests and by the host's keyless roads.
import { SSH_BYTES_OK, SSH_FACTS_SCRIPT, SSH_READ_SCRIPT, SshBackend, knownHostTarget, sshControlPath, type ExecResult, type SshHostKeyReader, type SshReach, type SshTransport } from "@wsp/engine";
import type { SshWiring } from "../src/runtime.js";

/** The key the box in this fake holds, which is what the client on this computer knows it by: two addresses for
 * that one machine answer with this one key, and a case reads it here rather than spelling it again. */
export const FAKE_BOX_KEY = "ssh-ed25519 SHA256:boxboxboxboxboxboxboxboxboxboxboxboxbox";

/** Two machines a person could reach over ssh, each with a home and a PATH of its own, so a road that reads one
 * machine's facts for another is a failure rather than a coincidence. */
const MACHINES: Record<string, { home: string; user: string; path: string; cpu: number; memkb: number; key: string; store?: string }> = {
  box: { home: "/home/dev", user: "dev", path: "/home/dev/.local/bin:/usr/bin", cpu: 8, memkb: 16_384_000, key: FAKE_BOX_KEY },
  // The same machine as box, under the address a person might use for it instead: one machine, one host key.
  "10.0.0.9": { home: "/home/dev", user: "dev", path: "/home/dev/.local/bin:/usr/bin", cpu: 8, memkb: 16_384_000, key: FAKE_BOX_KEY },
  "10.0.0.7": { home: "/root", user: "root", path: "/root/.bun/bin:/usr/bin", cpu: 2, memkb: 4_096_000, key: "ssh-ed25519 SHA256:sevensevensevensevensevensevenseven" },
  // A machine whose person points their harness at another folder, which is where their sign-in is.
  moved: { home: "/root", user: "root", path: "/usr/bin", cpu: 1, memkb: 1_024_000, key: "ssh-ed25519 SHA256:movedmovedmovedmovedmovedmoved", store: "/root/.claude-cfg" },
  // A machine whose home is a path with a space in it, which is a home on macOS.
  spaced: { home: "/Users/John Smith", user: "john", path: "/usr/bin", cpu: 4, memkb: 8_192_000, key: "ssh-ed25519 SHA256:spacedspacedspacedspacedspaced" },
  // The computer wsp is running on, reached the way any other machine is.
  "127.0.0.1": { home: "/root", user: "root", path: "/usr/bin", cpu: 2, memkb: 4_096_000, key: "ssh-ed25519 SHA256:hereherehereherehereherehere" },
};

/** The system and the length of time every machine in this fake says it is running, so a test reads one pair of
 * expected words wherever it asks. */
export const FAKE_OS = "Ubuntu 24.04.3 LTS";
export const FAKE_UPTIME_S = 90_061;

/** An ssh client that never leaves this computer: each machine answers the read with its own facts, every script it
 * was asked to carry is recorded, and a case scripts the answers. */
export function fakeSsh(answer: (script: string, reach: SshReach) => Partial<ExecResult> = () => ({})): { wiring: SshWiring; carried: { reach: SshReach; script: string; stdin?: Uint8Array }[]; masters: Set<string> } {
  const carried: { reach: SshReach; script: string; stdin?: Uint8Array }[] = [];
  /** What is on the machine, as the writes this fake saw left it. */
  const files = new Set<string>();
  /** The master connections this fake holds open, by the socket the real client names for the dial, and the key the
   * accept-new policy wrote for a machine as it was first dialled. A dial to a login, host and port one is already
   * open for rides it and exchanges no key, so nothing about that dial says which machine answered: what says it is
   * the entry the first dial left behind, which is what the reader below reads. */
  const masters = new Set<string>();
  const known = new Map<string, string>();
  /** The name an entry is written and read under, by the engine's own rule rather than a second spelling of it:
   * a port past ssh's own is bracketed, and ssh's own is the host on its own. */
  const entryFor = (reach: SshReach): string => knownHostTarget({ hostname: reach.host, port: String(reach.port) })!;
  const transport: SshTransport = async (reach, script, opts) => {
    carried.push({ reach, script, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const machine = MACHINES[reach.host];
    if (machine === undefined) return { exitCode: 255, stdout: "", stderr: `ssh: Could not resolve hostname ${reach.host}\n` };
    const socket = sshControlPath(reach, "/fake-masters");
    if (!masters.has(socket)) {
      masters.add(socket);
      known.set(entryFor(reach), machine.key);
    }
    if (script === SSH_READ_SCRIPT) {
      const store = machine.store === undefined ? "" : `store:CLAUDE_CONFIG_DIR ${machine.store}\n`;
      return { exitCode: 0, stdout: `home ${machine.home}\nuser ${machine.user}\npath ${machine.path}\n${store}cpu ${machine.cpu}\nmemkb ${machine.memkb}\n`, stderr: "" };
    }
    // What every one of these machines says it is when a status asks: a Linux, up for a day, and its own home,
    // so a row built for one machine that showed another's folder would be a failure rather than a coincidence.
    if (script === SSH_FACTS_SCRIPT) {
      return { exitCode: 0, stdout: `pretty ${FAKE_OS}\nmac \nkernel Linux 6.8.0-79-generic\nuptime ${FAKE_UPTIME_S}\nboot \nhome ${machine.home}\n`, stderr: "", ...answer(script, reach) };
    }
    // The machine's own byte road: the script the ssh machine writes a file with answers the way that machine's
    // shell would, so a road that lands bytes over the connection is proved with nothing on the network. What
    // landed is remembered, since the roads that ask whether a file is there read what an earlier write left.
    if (opts.stdin !== undefined) {
      const landed = /\nmv -f '[^']*' '([^']*)'\n/.exec(script)?.[1];
      if (landed !== undefined) files.add(landed);
      return { exitCode: 0, stdout: `${SSH_BYTES_OK}\n`, stderr: "", ...answer(script, reach) };
    }
    // `test -f '<path>' && echo A || echo B`, the one shape anything here asks a file about.
    const asked = /^test -f '([^']*)' && echo (\S+) \|\| echo (\S+)$/.exec(script.trim());
    if (asked !== null) return { exitCode: 0, stdout: `${files.has(asked[1]!) ? asked[2]! : asked[3]!}\n`, stderr: "", ...answer(script, reach) };
    return { exitCode: 0, stdout: "", stderr: "", ...answer(script, reach) };
  };
  /** What the client on this computer knows about a machine's key, which is the entry its first dial wrote: the
   * answer is the same whether this dial exchanged a key or rode a master. */
  const knownKey: SshHostKeyReader = async reach => known.get(entryFor(reach));
  const backend = new SshBackend({ transport, hostKey: knownKey });
  return {
    wiring: {
      backend,
    },
    carried,
    masters,
  };
}

