import { describe, expect, it } from "vitest";
import { GuestUnusableError } from "../src/errors.js";
import { Workspace } from "../src/lifecycle.js";
import type { Machine, MachineLife } from "../src/machine.js";

function stubMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1", kind: "sandbox",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    snapshot: async () => "snap_x", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
    streamUrl: undefined, ...overrides,
  };
}

function counting(overrides: Partial<Machine> = {}) {
  const calls = { pause: 0, resume: 0, kill: 0 };
  const machine = stubMachine({
    pause: async () => { calls.pause++; },
    resume: async () => { calls.resume++; },
    kill: async () => { calls.kill++; },
    ...overrides,
  });
  return { machine, calls };
}

describe("Workspace lifecycle", () => {
  it("checkpoint hands the machine the life it tracked, true before a wake and false after, and refuses nothing itself", async () => {
    const lives: MachineLife[] = [];
    const ws = new Workspace(stubMachine({ snapshot: async (_name, life) => { lives.push(life); return "snap_x"; } }), { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    await expect(ws.checkpoint("v1")).resolves.toBe("snap_x");
    await ws.nap();
    await ws.wake();
    await expect(ws.checkpoint("v2")).resolves.toBe("snap_x");
    expect(lives).toEqual([{ firstLife: true }, { firstLife: false }]);
  });
  it("a backend's refusal of a resumed machine comes through checkpoint as itself", async () => {
    const ws = new Workspace(stubMachine({ snapshot: async (name, life) => { if (!life.firstLife) throw new Error(`snapshot ${name} refused: resumed`); return "snap_x"; } }), { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    await ws.nap();
    await ws.wake();
    await expect(ws.checkpoint("v2")).rejects.toThrow("snapshot v2 refused: resumed");
  });
  it("wake resurrects from golden when the paused machine vanished", async () => {
    const dead = stubMachine({ resume: async () => { throw Object.assign(new Error("gone"), { kind: "missing" }); } });
    let resurrected = false;
    const ws = new Workspace(dead, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => { resurrected = true; return stubMachine({ id: "m2" }); },
    });
    await ws.nap();
    await ws.wake();
    expect(resurrected).toBe(true);
    expect(ws.machineId).toBe("m2");
  });
});

describe("Workspace verified wake", () => {
  it("the wake check dials a route minted after the resume, not the one cached before the nap, on both roads into the check", async () => {
    let minted = 0;
    const machine = stubMachine({ previewUrl: async port => ({ url: `https://m1-${port}.example`, token: `t${++minted}`, expiresAt: Date.now() + 3_600_000 }) });
    const handed: string[] = [];
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      wakeCheck: async () => { handed.push((await ws.daemonReach()).token); return undefined; },
    });
    const before = await ws.daemonReach();
    await ws.nap();
    await ws.wake();
    expect(before.token).toBe("t1");
    // The check's own dial minted again; the route cached before the nap was not what it went through.
    expect(handed).toEqual(["t2"]);
    // A resume that landed without its call takes the same road: the routes are dropped before the check.
    await ws.nap();
    await ws.wake({ landed: true });
    expect(handed).toEqual(["t2", "t3"]);
    expect(minted).toBe(3);
  });

  it("holds the phase at waking until the check passes, then stays on the same machine", async () => {
    const { machine, calls } = counting();
    const seen: string[] = [];
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => stubMachine({ id: "m2" }),
      wakeCheck: async () => { seen.push(ws.currentPhase); return undefined; },
    });
    await ws.nap();
    const result = await ws.wake();
    expect(seen).toEqual(["waking"]);
    expect(ws.currentPhase).toBe("running");
    expect(ws.machineId).toBe("m1");
    expect(result).toEqual({ resurrected: false });
    expect(calls.resume).toBe(1);
  });

  it("a check that fails once is paused and resumed again, and a passing second try keeps the machine", async () => {
    const { machine, calls } = counting();
    let checks = 0;
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => stubMachine({ id: "m2" }),
      wakeCheck: async () => (++checks === 1 ? "daemon did not answer" : undefined),
    });
    await ws.nap();
    const result = await ws.wake();
    expect(calls).toEqual({ pause: 2, resume: 2, kill: 0 });
    expect(ws.machineId).toBe("m1");
    expect(result.resurrected).toBe(false);
    expect(result.reason).toContain("daemon did not answer");
  });

  it("two failed checks resurrect from golden, restore the stashed vault, then kill the zombie", async () => {
    const { machine, calls } = counting();
    const order: string[] = [];
    const replacement = stubMachine({ id: "m2" });
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => { order.push("resurrect"); return replacement; },
      restoreVault: async m => { order.push(`restore:${m.id}`); },
      wakeCheck: async m => `memMb 2048 != 4096 on ${m.id}`,
    });
    await ws.nap();
    const result = await ws.wake();
    expect(calls).toEqual({ pause: 2, resume: 2, kill: 1 });
    expect(order).toEqual(["resurrect", "restore:m2"]);
    expect(ws.machineId).toBe("m2");
    expect(ws.isFirstLife).toBe(true);
    expect(ws.currentPhase).toBe("running");
    expect(result.resurrected).toBe(true);
    expect(result.reason).toMatch(/attempt 1: memMb 2048 != 4096 on m1; attempt 2: memMb 2048/);
  });

  it("a workspace given wakeAttempts 1 never re-pauses: one resume, a failed check, and the fork replaces it", async () => {
    const { machine, calls } = counting();
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 1,
      resurrect: async () => stubMachine({ id: "m2" }),
      wakeCheck: async () => "daemon did not answer",
    });
    await ws.nap();
    const result = await ws.wake();
    // A provider that bills every start declares one attempt: the re-pause and second resume never happen.
    expect(calls).toEqual({ pause: 1, resume: 1, kill: 1 });
    expect(ws.machineId).toBe("m2");
    expect(result).toEqual({ resurrected: true, reason: "attempt 1: daemon did not answer" });
  });

  it("a resume that ends with the guest unusable is a fault: no check runs, the fork replaces the machine, the vault comes back, and the reason carries the provider's words", async () => {
    const { machine, calls } = counting({ resume: async () => { throw new GuestUnusableError("m1", "Box by ASCII", "Error 24", 200); } });
    const restored: string[] = [];
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => stubMachine({ id: "m2" }),
      restoreVault: async m => { restored.push(m.id); },
      wakeCheck: async () => { throw new Error("a machine nothing can run on is never checked"); },
    });
    await ws.nap();
    const result = await ws.wake();
    expect(result.resurrected).toBe(true);
    expect(result.reason).toMatch(/Box by ASCII left m1 running but nothing on it can run: Error 24/);
    expect(ws.machineId).toBe("m2");
    expect(ws.currentPhase).toBe("running");
    expect(restored).toEqual(["m2"]);
    // The fault is the machine's, not the moment's: no second resume, no re-pause, and the old box is killed.
    expect(calls).toEqual({ pause: 1, resume: 0, kill: 1 });
  });

  it("nap stashes the vault before the pause", async () => {
    const order: string[] = [];
    const machine = stubMachine({ pause: async () => { order.push("pause"); } });
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2, stashVault: async () => { order.push("stash"); } });
    await ws.nap();
    expect(order).toEqual(["stash", "pause"]);
  });

  it("a machine that vanished while paused is replaced and gets the stashed vault too", async () => {
    const dead = stubMachine({ resume: async () => { throw Object.assign(new Error("gone"), { kind: "missing" }); } });
    const restored: string[] = [];
    const ws = new Workspace(dead, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => stubMachine({ id: "m2" }),
      restoreVault: async m => { restored.push(m.id); },
    });
    await ws.nap();
    const result = await ws.wake();
    expect(restored).toEqual(["m2"]);
    expect(result.resurrected).toBe(true);
    expect(result.reason).toContain("vanished");
  });

  it("noteRunning puts a napping phase back to running, so the next nap pauses the machine for real", async () => {
    const { machine, calls } = counting();
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2 }, { phase: "napping" });
    await ws.nap();
    expect(calls.pause).toBe(0);
    ws.noteRunning();
    expect(ws.currentPhase).toBe("running");
    await ws.nap();
    expect(calls.pause).toBe(1);
    expect(ws.currentPhase).toBe("napping");
  });

  it("a failed wake with no resurrect hook throws and leaves the workspace napping", async () => {
    const { machine } = counting();
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g", wakeAttempts: 2, wakeCheck: async () => "no daemon" });
    await ws.nap();
    await expect(ws.wake()).rejects.toThrow(/no daemon/);
    expect(ws.currentPhase).toBe("napping");
  });
});

describe("Workspace provider moves", () => {
  it("nap and wake run their pause and resume through the move hook with the machine, so the caller can bound them", async () => {
    const { machine, calls } = counting();
    const moves: string[] = [];
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      move: async (m, move) => { moves.push(`${move}@${m.id}`); await m[move](); },
    });
    await ws.nap();
    await ws.wake();
    expect(moves).toEqual(["pause@m1", "resume@m1"]);
    expect(calls).toMatchObject({ pause: 1, resume: 1 });
  });

  it("a wake's re-pause after a failed check goes through the hook too, and a move the hook gives up on leaves the phase where it was", async () => {
    const { machine } = counting();
    const moves: string[] = [];
    let checks = 0;
    const ws = new Workspace(machine, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => stubMachine({ id: "m2" }),
      wakeCheck: async () => (++checks === 1 ? "no daemon" : undefined),
      move: async (m, move) => {
        moves.push(move);
        if (moves.length === 1) throw new Error("pause did not complete");
        await m[move]();
      },
    });
    await expect(ws.nap()).rejects.toThrow("pause did not complete");
    expect(ws.currentPhase).toBe("running");
    await ws.nap();
    expect(ws.currentPhase).toBe("napping");
    await ws.wake();
    expect(moves).toEqual(["pause", "pause", "resume", "pause", "resume"]);
    expect(ws.machineId).toBe("m1");
  });
});

describe("Workspace rebuild", () => {
  it("replaces a running machine with a golden fork, restores the vault, kills the old one, and stays running first-life", async () => {
    const calls = { kill: 0, pause: 0, resume: 0 };
    const zombie = stubMachine({
      kill: async () => { calls.kill++; },
      pause: async () => { calls.pause++; },
      resume: async () => { calls.resume++; },
    });
    const order: string[] = [];
    const ws = new Workspace(zombie, {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => { order.push("resurrect"); return stubMachine({ id: "m2" }); },
      restoreVault: async m => { order.push(`restore:${m.id}`); },
    }, { firstLife: false });
    await ws.rebuild();
    expect(order).toEqual(["resurrect", "restore:m2"]);
    expect(calls).toEqual({ kill: 1, pause: 0, resume: 0 });
    expect(ws.machineId).toBe("m2");
    expect(ws.currentPhase).toBe("running");
    expect(ws.isFirstLife).toBe(true);
  });

  it("a napping workspace rebuilds too and comes back running", async () => {
    const ws = new Workspace(stubMachine(), {
      goldenSnapshot: "snap_g",
      wakeAttempts: 2,
      resurrect: async () => stubMachine({ id: "m2" }),
    });
    await ws.nap();
    await ws.rebuild();
    expect(ws.machineId).toBe("m2");
    expect(ws.currentPhase).toBe("running");
  });

  it("refuses without a resurrect hook and keeps the machine", async () => {
    const ws = new Workspace(stubMachine(), { goldenSnapshot: "snap_g", wakeAttempts: 2 });
    await expect(ws.rebuild()).rejects.toThrow(/resurrect/);
    expect(ws.machineId).toBe("m1");
  });
});
