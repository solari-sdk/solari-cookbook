// SPDX-License-Identifier: AGPL-3.0-only
// The computer itself as a machine: the frames it sends over the link its
// daemon holds, and the calls that belong to a workspace and are refused here.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXEC_TIMEOUT_MAX_MS, placeProvisionPaths } from "@wsp/protocol";
import { INLINE_EXEC_MS, execFits } from "../src/exec-detached.js";
import { LINK_MARGIN_MS } from "../src/link-backend.js";
import { NOT_A_WORKSPACE, PLACE_PART_BYTES, PlaceMachine, placePartBoundMs } from "../src/place-machine.js";
import { spawnSyncFed } from "../src/spawn-fed.js";

const HOME = "/root";

/** The link a computer holds, answering the exec frame the way its daemon does: the launch and the polls of a
 * detached run, and exit 0 for everything else. */
function link(answer: (cmd: string) => { exitCode: number; stdout: string; stderr: string } | undefined = () => undefined) {
  const frames: { op: string; params: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  return {
    frames,
    request: async (op: string, params: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => {
      frames.push({ op, params, opts });
      const cmd = String(params["cmd"] ?? "");
      const said = answer(cmd);
      if (said !== undefined) return { ...said, truncated: false };
      if (cmd.includes("echo WSP_LAUNCHED")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "", truncated: false };
      if (cmd.includes("echo WSP_POLL")) return { exitCode: 0, stdout: "WSP_POLL\n0\n\n\ndown\nWSP_POLL_END\n", stderr: "", truncated: false };
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    },
  };
}

const machineOn = (l: ReturnType<typeof link>): PlaceMachine => new PlaceMachine(l, { id: "spoo", home: HOME });

describe("a command on the computer itself", () => {
  it("rides the daemon's own exec frame, with the wait it asked for and the margin the link takes on top", async () => {
    const l = link(cmd => (cmd === "echo hi" ? { exitCode: 3, stdout: "hi\n", stderr: "oops\n" } : undefined));
    const res = await machineOn(l).exec("echo hi");
    expect(res).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "oops\n" });
    expect(l.frames).toEqual([{ op: "exec", params: { cmd: "echo hi", timeoutMs: INLINE_EXEC_MS }, opts: { timeoutMs: INLINE_EXEC_MS + LINK_MARGIN_MS } }]);
  });

  it("holds the wait under the cap the daemon holds its own timer to, and carries a key the caller said may be asked twice", async () => {
    const l = link();
    await machineOn(l).exec("sleep 1", { timeoutMs: EXEC_TIMEOUT_MAX_MS * 2, idempotencyKey: "upload/1" });
    expect(l.frames[0]!.params["timeoutMs"]).toBe(EXEC_TIMEOUT_MAX_MS);
    expect(l.frames[0]!.opts).toEqual({ timeoutMs: EXEC_TIMEOUT_MAX_MS + LINK_MARGIN_MS, idempotencyKey: "upload/1" });
  });

  it("carries the bytes a caller gave it for the command's own stdin on the frame, as base64, and nothing of them in the command", async () => {
    const l = link();
    const stdin = Buffer.from([0, 1, 2, 250, 251]);
    await machineOn(l).exec("cat > /root/x", { stdin });
    expect(l.frames).toEqual([{ op: "exec", params: { cmd: "cat > /root/x", timeoutMs: INLINE_EXEC_MS, stdin: stdin.toString("base64") }, opts: { timeoutMs: INLINE_EXEC_MS + LINK_MARGIN_MS } }]);
  });
});

describe("a step that may run for minutes", () => {
  it("is launched under wsp's own folder on that computer, not one every login there shares", async () => {
    const l = link();
    const res = await machineOn(l).run("apt-get install -y -qq jq", { deadlineMs: 60_000, pollMs: 1 });
    expect(res.exitCode).toBe(0);
    const launch = l.frames.find(f => String(f.params["cmd"]).includes("echo WSP_LAUNCHED"))!;
    expect(String(launch.params["cmd"])).toContain(`b=${placeProvisionPaths(HOME).runDir}/`);
    expect(placeProvisionPaths(HOME).runDir).toBe("/root/.wsp/provision/run");
  });
});

describe("bytes onto the computer itself", () => {
  /** The parts of one put: the frames that carried bytes on their stdin, in the order they were sent. */
  const partsOf = (l: ReturnType<typeof link>) => l.frames.filter(f => f.params["stdin"] !== undefined);

  it("cross in parts, each one frame whose bytes ride its stdin and whose command carries none of them", async () => {
    const l = link();
    const file = Buffer.alloc(3 * PLACE_PART_BYTES, 7);
    const landed = await machineOn(l).putBytes("/root/.wsp/provision/in.tgz", file);
    const parts = partsOf(l);
    expect(parts).toHaveLength(3);
    expect(landed).toEqual({ pieces: parts.length });
    // The command is a short line whatever the part weighs, so the bytes are never what the exec body has to hold
    // and no part of them is bounded by the cap the daemon refuses a command over.
    for (const f of parts) {
      expect(Buffer.byteLength(String(f.params["cmd"]))).toBeLessThan(200);
      expect(execFits(String(f.params["cmd"]))).toBe(true);
    }
    expect(l.frames).toHaveLength(parts.length + 1);
    expect(String(l.frames.at(-1)!.params["cmd"])).toContain("cat '/root/.wsp/provision/in.tgz'.part{0..2} > '/root/.wsp/provision/in.tgz'");
  });

  it("cross as base64 once, not as base64 of base64, and in order", async () => {
    const l = link();
    const file = Buffer.concat([Buffer.alloc(PLACE_PART_BYTES, 1), Buffer.alloc(PLACE_PART_BYTES, 2), Buffer.from("tail")]);
    await machineOn(l).putBytes("/root/.wsp/provision/in.tgz", file);
    const crossed = Buffer.concat(partsOf(l).map(f => Buffer.from(String(f.params["stdin"]), "base64")));
    expect(crossed).toEqual(file);
  });

  it("bound each frame by the bytes it carries at the rate this link has shown, never by the default alone", async () => {
    // A part of the size above is 1.4 MB of base64 on the wire and crosses in 6.6 s at that rate; twice that is
    // under the bound a plain command gets, so the plain bound stands. A part four times the size asks for its own.
    expect(placePartBoundMs(PLACE_PART_BYTES)).toBe(INLINE_EXEC_MS);
    expect(placePartBoundMs(4 * 1024 * 1024)).toBe(52_512);
    expect(placePartBoundMs(64 * 1024 * 1024)).toBe(EXEC_TIMEOUT_MAX_MS);
    const l = link();
    await machineOn(l).putBytes("/root/.wsp/provision/in.tgz", Buffer.alloc(PLACE_PART_BYTES + 1, 7));
    expect(partsOf(l).map(f => f.params["timeoutMs"])).toEqual([placePartBoundMs(PLACE_PART_BYTES), placePartBoundMs(1)]);
    expect(partsOf(l).map(f => f.opts["timeoutMs"])).toEqual([INLINE_EXEC_MS + LINK_MARGIN_MS, INLINE_EXEC_MS + LINK_MARGIN_MS]);
  });

  it("leave nothing of the file on the computer where a frame failed", async () => {
    const l = link(cmd => (cmd.endsWith(".part1") ? { exitCode: 1, stdout: "", stderr: "no space left on device" } : undefined));
    const put = machineOn(l).putBytes("/root/.wsp/provision/in.tgz", Buffer.alloc(3 * PLACE_PART_BYTES, 7));
    await expect(put).rejects.toThrow("part 2 of 3 did not land at /root/.wsp/provision/in.tgz on spoo: it exited 1 and said: no space left on device");
    // Every part name, including the one whose frame failed and the ones that never went: a part can stand on that
    // computer with its answer lost.
    expect(String(l.frames.at(-1)!.params["cmd"])).toBe("rm -f '/root/.wsp/provision/in.tgz'.part{0..2}");
  });

  it("land the same bytes once where the link lost an answer and the frame was sent again", async () => {
    const l = link();
    const at = mkdtempSync(join(tmpdir(), "wsp-place-"));
    const path = join(at, "deep", "in.tgz");
    const file = Buffer.concat([Buffer.alloc(PLACE_PART_BYTES, 3), Buffer.from("tail")]);
    await machineOn(l).putBytes(path, file);
    // Every frame this put sent, run by a real shell, with the part frames and the join each sent twice: what the
    // link does with a frame whose answer it lost is send it again, and the file must read the same either way.
    for (const f of l.frames) {
      const stdin = f.params["stdin"] === undefined ? Buffer.alloc(0) : Buffer.from(String(f.params["stdin"]), "base64");
      for (const send of [1, 2]) {
        const ran = spawnSyncFed("bash", ["-c", String(f.params["cmd"])], stdin, { encoding: "utf8", timeout: 15_000 });
        expect(ran.error, `send ${send} of ${String(f.params["cmd"])} did not finish`).toBeUndefined();
        expect(ran.status, ran.stderr).toBe(0);
      }
    }
    expect(readFileSync(path)).toEqual(file);
    expect(readdirSync(join(at, "deep"))).toEqual(["in.tgz"]);
    rmSync(at, { recursive: true, force: true });
  });
});

describe("the calls that belong to a workspace", () => {
  it("are refused in one sentence rather than sent as a frame nothing on the far side takes", async () => {
    const l = link();
    const machine = machineOn(l);
    for (const call of [machine.snapshot(), machine.pause(), machine.resume(), machine.kill(), machine.downloadUrl(), machine.uploadUrl()]) {
      await expect(call).rejects.toThrow(NOT_A_WORKSPACE);
    }
    expect(l.frames).toEqual([]);
    // It is the computer, so it is running: nothing is asked and nothing waits on an answer.
    expect(await machine.state()).toBe("running");
    expect(l.frames).toEqual([]);
  });
});
