// Field-notes regression file: one live canary per Solari platform bug we
// coded around (solari-poc/RESULTS.md, 2026-09-01). Each asserts the CURRENT
// behavior and shouts when the platform starts behaving differently, so the
// corresponding guard can be relaxed (or restored) deliberately:
//   1. snapshot-after-restore 502  -> engine's snapshot-fresh rule (lifecycle.ts)
//   2. desktop control-WS 1006     -> FIXED upstream 2026-09-01; canary now
//      guards the fix (REST /exec stays as the conservative default in wsp)
//   3. docker can't run containers -> no Docker-based features
//   4. previewUrl survives pause+wake -> daemonReach's cross-nap reuse
//      (docs claim the url dies with the machine; measured otherwise)
// A canary failing loudly is the signal to go adjust a workaround on purpose,
// not a regression in wsp.

import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { classify, shouldRetry, type WspError } from "../src/errors.js";
import { SolariBackend } from "../src/solari-backend.js";
import type { Machine } from "../src/machine.js";
import { isReserved, LIVE, sleep, solariKey } from "./live.js";

const TEST_LABEL = { wsp: "1", "wsp-test": "quirks", createdAt: new Date().toISOString() };
const SHOUT = (msg: string) => console.error(`\n${"!".repeat(72)}\n!! ${msg}\n${"!".repeat(72)}\n`);

describe.runIf(LIVE)("solari platform-bug canaries", () => {
  const apiKey = LIVE ? solariKey() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === TEST_LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  it("canary 1: snapshot after pause+resume (502 boundary is fuzzy: same-host naps snapshot fine)", { timeout: 240_000 }, async () => {
    // The deterministic half: the bug's signature must stay classified as
    // non-retryable, or the retry loop would hammer a permanent failure 3x.
    const sig = classify(502, { error: "Failed to snapshot sandbox" });
    expect(sig.kind).toBe("snapshotUnavailable");
    expect(shouldRetry(sig, 1)).toBe(false);

    // The live half accepts EITHER outcome (quick same-host resumes are known
    // to snapshot fine; aged/cross-host restores are the ones that 502) and
    // only asserts that a failure, when it happens, wears the classification
    // the engine's guards key on.
    const m = await backend.create({ kind: "sandbox", cpu: 1, memMb: 2048, labels: TEST_LABEL });
    try {
      await m.exec("echo warm");
      await m.pause();
      await m.resume();
      let outcome: "snapshotted" | "snapshotUnavailable";
      let snapId: string | undefined;
      try {
        snapId = await m.snapshot("quirk-canary", { firstLife: true });
        outcome = "snapshotted";
      } catch (e) {
        const err = e as WspError;
        if (err.kind !== "snapshotUnavailable") throw e; // a genuinely new failure mode
        outcome = "snapshotUnavailable";
      }
      if (outcome === "snapshotted") {
        SHOUT(
          "CANARY 1: snapshot after pause+resume SUCCEEDED (same-host resume path). " +
            "This is the known-fuzzy boundary, NOT proof the aged/cross-host 502 is fixed. " +
            "The snapshot-fresh rule stays until an aged restore snapshots clean.",
        );
        if (snapId) await backend.deleteSnapshot(snapId).catch(() => {});
      } else {
        SHOUT(
          "CANARY 1: snapshot after resume 502'd with the known signature " +
            "(kind=snapshotUnavailable). Platform bug still present; guards stay.",
        );
      }
      expect(["snapshotted", "snapshotUnavailable"]).toContain(outcome);
    } finally {
      await m.kill().catch(() => {});
    }
  });

  // HISTORY: the PoC (2026-09-01 ~03:00, solari-poc/RESULTS.md P4/P4b) saw the
  // desktop control WS die with 1006 on the first command, 3/3 across the code
  // and workstation templates, and wsp adopted a REST-/exec-only rule for
  // desktops. This canary was written to assert that breakage and FLIPPED on
  // its very first run (2026-09-01 ~17:00 IST): first-command-over-control-WS
  // then succeeded 4/4 across both templates, with and without waiting for
  // REST readiness. So it now asserts the FIXED behavior; if it starts failing
  // with 1006 again, the platform regressed and the REST-only rule goes back.
  it("canary 2: desktop control WS first command works (1006 bug FIXED 2026-09-01; was: REST /exec only)", { timeout: 240_000 }, async () => {
    const desktop = await backend.create({
      kind: "desktop",
      template: "workstation",
      cpu: 2,
      memMb: 4096,
      labels: TEST_LABEL,
    });
    try {
      // Two attempts absorb fresh-boot flake without hiding a real regression.
      let outcome = await firstCommandOverControlWs(apiKey, desktop.id);
      if (outcome.kind !== "success") {
        await sleep(5000);
        outcome = await firstCommandOverControlWs(apiKey, desktop.id);
      }
      if (outcome.kind === "success") {
        SHOUT(
          "CANARY 2: desktop control-WS first command still works (exit " +
            `${outcome.exitCode}). The 1006 bug stays fixed; desktops may be ` +
            "driven over the control channel as well as REST /exec.",
        );
      } else {
        SHOUT(
          "CANARY 2 REGRESSED: desktop control WS died on first command again " +
            `(${outcome.kind}${outcome.code !== undefined ? ` code=${outcome.code}` : ""}: ${outcome.detail}). ` +
            "Reinstate the REST-/exec-only rule for desktops.",
        );
      }
      expect(outcome.kind, "desktop control WS regressed to dying on first command").toBe("success");
    } finally {
      await desktop.kill().catch(() => {});
    }
  });

  it("canary 3: docker cannot run containers in sandboxes (kernel 6.6.30: no overlayfs, broken netfilter)", { timeout: 300_000 }, async () => {
    const m = await backend.create({ kind: "sandbox", cpu: 2, memMb: 4096, labels: TEST_LABEL });
    try {
      const install = await m.exec(
        "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null 2>&1; " +
          "command -v docker || echo NO_DOCKER_BIN",
        { timeoutMs: 120_000 },
      );
      expect(install.stdout).not.toContain("NO_DOCKER_BIN");

      // Most charitable attempt (P6b): degraded daemon, host networking.
      const daemon = await m.exec(
        "nohup dockerd --iptables=false --ip6tables=false --bridge=none --storage-driver=vfs >/tmp/dockerd.log 2>&1 & " +
          "for i in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done; " +
          "docker info --format 'DAEMON_UP driver={{.Driver}}' 2>&1 | tail -1",
        { timeoutMs: 60_000 },
      );
      const hello = await m.exec(
        "docker run --rm --network=host hello-world 2>&1 | grep -m1 'Hello from Docker' || echo NO_RUN; " +
          "tail -c 300 /tmp/dockerd.log 2>/dev/null | tr '\\n' ' '",
        { timeoutMs: 90_000 },
      );
      const ran = hello.stdout.includes("Hello from Docker");
      if (ran) {
        SHOUT(
          "CANARY 3 FLIPPED: docker ran hello-world inside a sandbox. The kernel " +
            "gap is gone; Docker-based features are back on the table.",
        );
      } else {
        SHOUT(
          `CANARY 3: docker still cannot run containers (daemon: ${daemon.stdout.trim().slice(0, 80)}; ` +
            `run: ${hello.stdout.trim().slice(0, 160)}). Platform gap persists.`,
        );
      }
      expect(ran, "docker hello-world ran; the platform gap is fixed").toBe(false);
    } finally {
      await m.kill().catch(() => {});
    }
  });

  // Docs say preview URLs die with the machine; measured (ticket-6 spike,
  // 2026-09-01): they only go dark WHILE paused, and the same url+token routes
  // again ~1s after wake. Workspace.daemonReach depends on that by keeping the
  // minted reach across nap+wake; if this canary fails, wake must remint.
  it("canary 4: previewUrl survives pause+wake (same url routes after resume)", { timeout: 240_000 }, async () => {
    const m = await backend.create({ kind: "sandbox", cpu: 1, memMb: 2048, labels: TEST_LABEL });
    try {
      const listen = await m.exec(
        "command -v python3 >/dev/null || echo NO_PYTHON3; " +
          "setsid nohup python3 -m http.server 7070 --bind 0.0.0.0 >/tmp/http.log 2>&1 < /dev/null & " +
          "sleep 1; ss -ltn | grep -q 7070 && echo LISTENING || echo NOT_LISTENING",
      );
      expect(listen.stdout, "in-guest listener on 0.0.0.0:7070 failed to start").toContain("LISTENING");

      if (!m.previewUrl) throw new Error("SolariMachine lost previewUrl support");
      const reach = await m.previewUrl(7070);
      // exp claim is epoch ms 60 min out; a failed parse would also land at
      // +60min, so the window mainly guards seconds-vs-ms confusion.
      expect(reach.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
      expect(reach.expiresAt).toBeLessThan(Date.now() + 70 * 60_000);
      expect((await routes(reach.url)).ok, "freshly minted previewUrl does not route").toBe(true);

      await m.pause();
      while ((await m.state()) !== "paused") await sleep(1000);
      await m.resume();
      while ((await m.state()) !== "running") await sleep(1000);

      const after = await routes(reach.url);
      if (after.ok) {
        SHOUT(
          "CANARY 4: previewUrl survived pause+wake (same url+token routed " +
            `post-resume, status ${after.status}). daemonReach may keep reusing across naps.`,
        );
      } else {
        SHOUT(
          `CANARY 4 REGRESSED: previewUrl no longer routes after pause+wake (${after.detail}). ` +
            "Platform behavior changed; Workspace.daemonReach must remint on wake.",
        );
      }
      expect(after.ok, "previewUrl stopped surviving pause+wake").toBe(true);
    } finally {
      await m.kill().catch(() => {});
    }
  });
});

/** GET the preview URL until the in-guest listener answers; the edge 502s
 * while the guest dial is not ready (first dial ~1s, post-wake ~1s). */
async function routes(url: string): Promise<{ ok: boolean; status?: number; detail: string }> {
  let detail = "no attempt";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return { ok: true, status: res.status, detail: `HTTP ${res.status}` };
      detail = `HTTP ${res.status}`;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    await sleep(2000);
  }
  return { ok: false, detail: `${detail} after 6 attempts` };
}

type ControlOutcome =
  | { kind: "success"; exitCode: number; detail: string }
  | { kind: "closed" | "error" | "timeout"; code?: number; detail: string };

/** Raw control-channel client: Bearer on upgrade, newline-delimited JSON
 * frames `{id, method, params}` -> `{id, ok, result}` + async `cmd.*` frames
 * (the @solarisdk transport contract, reimplemented to keep the canary
 * SDK-free). Success needs BOTH the cmd.start reply and a cmd.exit frame. */
function firstCommandOverControlWs(apiKey: string, sandboxId: string): Promise<ControlOutcome> {
  return new Promise(resolve => {
    const url = `wss://api.getsolari.com/control/${encodeURIComponent(sandboxId)}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    let settled = false;
    let buffer = "";
    let sawOkReply = false;
    const done = (o: ControlOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already dead */
      }
      resolve(o);
    };
    const timer = setTimeout(
      () => done({ kind: "timeout", detail: `no reply+exit within 30s (okReply=${sawOkReply})` }),
      30_000,
    );

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: "1", method: "cmd.start", params: { cmd: "echo", args: ["canary"] } }) + "\n");
    });
    ws.on("message", raw => {
      buffer += String(raw);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: { id?: string; ok?: boolean; type?: string; exitCode?: number; error?: unknown };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          continue;
        }
        if (frame.id === "1" && frame.ok === true) sawOkReply = true;
        if (frame.id === "1" && frame.ok === false) {
          done({ kind: "error", detail: `rpc error: ${JSON.stringify(frame.error).slice(0, 120)}` });
        }
        if (frame.type === "cmd.exit") {
          done({ kind: "success", exitCode: frame.exitCode ?? -1, detail: "reply + cmd.exit received" });
        }
      }
    });
    ws.on("close", (code, reason) =>
      done({ kind: "closed", code, detail: `closed ${code} ${String(reason)} (okReply=${sawOkReply})` }),
    );
    ws.on("error", err => done({ kind: "error", detail: String(err).slice(0, 160) }));
  });
}
