// SPDX-License-Identifier: AGPL-3.0-only
// The guest side of the launch/poll/kill contract machineExecStream speaks,
// in memory: a log file that grows between polls, an exit file, and a leader
// process that can die. Shared because more than one road is tested against a
// guest that behaves, and a second copy of the contract would drift from it.
import type { ExecResult } from "@wsp/engine";
import type { StubBackend } from "./stub-backend.js";

export interface Step {
  append?: Buffer | string;
  exit?: number;
  dead?: boolean;
  /** Work ticks the run's process group did since the poll before, as the guest's own read would count them. */
  work?: number;
}

/** `steps` moves the guest on one poll at a time; a guest given none stays as it is until a test appends to its log
 * or writes its exit file by hand, which is what a run driven by something other than the poll count needs.
 * `otherwise` answers everything else the machine is asked, which a guest under a whole runtime needs and a guest
 * under one stream does not: unanswered, a command this contract knows nothing about is a fault in the test. */
export function scriptGuest(backend: StubBackend, steps: Step[], otherwise?: StubBackend["execImpl"]) {
  let log = Buffer.alloc(0);
  let exitFile = "";
  let alive = true;
  /** What the group's work read answers, as it only ever grows on a real guest. */
  let work = 0;
  let child = false;
  let launch = "";
  let step = 0;
  /** The claim directory the launch makes: what says the run is still on the guest, until the reap takes it. */
  let claimed = false;
  /** What the probe for the claim does instead of answering: throw, or answer something that is not an answer. */
  let probeFails: Error | undefined;
  let probeGarbles = false;
  let probes = 0;
  const kills: string[] = [];
  const writes: string[] = [];
  const calls: string[] = [];
  const pieces = new Map<string, string>();
  /** What is on the guest now; the reap empties it. */
  const disk = new Map<string, string>();
  /** What every exec wrote, kept after the reap so a test can read the script it ran. */
  const landed = new Map<string, string>();
  const at = (suffix: string): string => [...landed].find(([path]) => path.endsWith(suffix))?.[1] ?? "";
  /** Lands every file the exec writes, inline or joined from pieces, replaced or appended. */
  const land = (cmd: string): void => {
    for (const m of cmd.matchAll(/(?:printf %s '([A-Za-z0-9+/=]*)'|cat '([^']*)'\.\{0\.\.(\d+)\}) \| base64 -d (>>?) '([^']*)'/g)) {
      const b64 = m[1] ?? Array.from({ length: Number(m[3]) + 1 }, (_, i) => pieces.get(`${m[2]}.${i}`) ?? "").join("");
      const text = (m[4] === ">>" ? at(m[5]!) : "") + Buffer.from(b64, "base64").toString("utf8");
      disk.set(m[5]!, text);
      landed.set(m[5]!, text);
    }
  };

  backend.execImpl = async (machine, cmd): Promise<ExecResult> => {
    calls.push(cmd);
    if (cmd.endsWith("echo WSP_PIECE")) {
      const m = /printf %s '([A-Za-z0-9+/=]*)' > '([^']*)'\.(\d+) \|\| exit 1\n/.exec(cmd);
      if (m === null) throw new Error(`piece exec without a numbered file: ${cmd}`);
      pieces.set(`${m[2]}.${m[3]}`, m[1]!);
      return { exitCode: 0, stdout: "WSP_PIECE\n", stderr: "" };
    }
    if (cmd.includes("WSP_LAUNCHED")) {
      launch = cmd;
      land(cmd);
      child = true;
      claimed = true;
      return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    }
    if (cmd.includes("WSP_RUN")) {
      probes++;
      if (probeFails !== undefined) throw probeFails;
      if (probeGarbles) return { exitCode: 1, stdout: "", stderr: "bash: line 1: unexpected" };
      return { exitCode: 0, stdout: claimed ? "WSP_RUN\n" : "WSP_GONE\n", stderr: "" };
    }
    if (cmd.includes("kill -KILL") || cmd.includes("kill -TERM")) {
      kills.push(cmd);
      // A signal to the group takes the leader and what it spawned; one to a pid takes that pid alone.
      if (cmd.includes("-- -$P")) child = false;
      if (!cmd.includes(".tail")) alive = false;
      const rm = /rm -rf '([^']+)'\.\*/.exec(cmd);
      if (rm) {
        claimed = false;
        for (const path of [...disk.keys()]) if (path.startsWith(`${rm[1]}.`)) disk.delete(path);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd.includes("echo WSP_OK")) {
      writes.push(cmd);
      if (exitFile !== "") return { exitCode: 0, stdout: "WSP_GONE\n", stderr: "" };
      land(cmd);
      return { exitCode: 0, stdout: "WSP_OK\n", stderr: "" };
    }
    const sentinel = cmd.match(/(__WSP_EOF_[a-z0-9]+__)/)?.[1];
    if (sentinel) {
      const s = steps[step];
      if (s) {
        step++;
        if (s.append !== undefined) log = Buffer.concat([log, Buffer.from(s.append)]);
        if (s.exit !== undefined) exitFile = String(s.exit);
        if (s.dead) alive = false;
        work += s.work ?? 0;
      }
      const from = Number(cmd.match(/tail -c \+(\d+)/)?.[1] ?? "1") - 1;
      const chunk = log.subarray(from, from + 262144);
      // The work field is what the poll asked for: a poll that carries no read leaves $W empty, as the guest's own
      // printf does for an unset variable.
      const asked = cmd.includes("awk -v p=");
      return {
        exitCode: 0,
        stdout: `${chunk.toString("base64")}\n${sentinel} ${exitFile} ${alive ? "up" : "down"} ${asked ? work : ""}\n`,
        stderr: "",
      };
    }
    if (otherwise !== undefined) return otherwise(machine, cmd);
    throw new Error(`guest got unexpected command: ${cmd}`);
  };
  return {
    kills,
    writes,
    calls,
    getScript: () => at(".sh"),
    getLaunch: () => launch,
    getInput: () => at(".in"),
    exit: (code: number) => (exitFile = String(code)),
    /** Bytes the run printed since the last poll, as the guest's own log would have grown. */
    append: (text: string) => (log = Buffer.concat([log, Buffer.from(text)])),
    childAlive: () => child,
    files: () => [...disk.keys()],
    /** The guest swept the run's files with no reader of its own around, as a reboot or a tmp sweep would. */
    sweep: () => (claimed = false),
    /** The machine stops answering the one question the attach asks, the way a gateway or a nap does. */
    refuseProbes: (e: Error) => (probeFails = e),
    /** The machine answers, but says neither that it holds the run nor that it does not. */
    garbleProbes: () => (probeGarbles = true),
    probes: () => probes,
  };
}
