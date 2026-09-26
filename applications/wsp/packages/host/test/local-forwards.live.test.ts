// SPDX-License-Identifier: AGPL-3.0-only
// Localhost forwards against one real machine: the daemon deployed the host's
// way, a dev server started from a daemon pty (the wsp terminal's road), its
// printed URL forwarded to this computer, listed and stopped over the runtime
// socket the app reads, and a real curl on this Mac answered by the guest.
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";
import { DAEMON_PORT, SolariBackend, isReserved, type PreviewReach } from "@wsp/engine";
import type { GoldenBuilderView } from "@wsp/protocol";
import { connectDaemon, createRuntime, memoryStore, serveRuntime, type Runtime, type RuntimeServer } from "@wsp/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { WsClient } from "../../runtime/test/ws-client.js";
import { DAEMON_DEPLOYED_LINE, GUEST_ENVS, deployDaemon } from "../src/doctor.js";
import { startCallbackRelay, type CallbackRelay } from "../src/relay.js";

const execFileAsync = promisify(execFile);
const LABEL = { wsp: "1", "wsp-test": "local-forwards-live" };
const PORT = 8123;

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

function refused(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED"));
  });
}

describe.runIf(LIVE)("localhost forwards (live)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  let machineId: string | undefined;

  afterAll(async () => {
    if (!LIVE || machineId === undefined) return;
    await backend.get(machineId).then(m => m.kill()).catch(() => {});
  });

  it("python3 -m http.server 8123 in a wsp terminal is forwarded, listed, answered by curl here, and stopped from the app's socket", { timeout: 600_000 }, async () => {
    const t0 = Date.now();
    const machine = await backend.create({ kind: "sandbox", template: "base", cpu: 2, memMb: 4096, envs: GUEST_ENVS, labels: { ...LABEL, createdAt: new Date().toISOString() } });
    machineId = machine.id;
    const { token } = await deployDaemon(machine);
    const notes: string[] = [`machine ${machine.id} created and ${DAEMON_DEPLOYED_LINE} deployed at ${Date.now() - t0}ms`];
    const builder: GoldenBuilderView = { id: machine.id, name: "forwards-live", kind: "sandbox", createdAt: new Date().toISOString(), size: { cpu: 2, memMb: 4096 } };
    let minted: PreviewReach | undefined;
    const base = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const rt: Runtime = {
      ...base,
      golden: {
        ...base.golden,
        builderReach: async () => {
          minted ??= await machine.previewUrl!(DAEMON_PORT);
          return { url: minted.url, expiresAt: minted.expiresAt, daemonToken: token };
        },
      },
    };

    const lines: string[] = [];
    let relay: CallbackRelay | undefined;
    let srv: RuntimeServer | undefined;
    let app: WsClient | undefined;
    let link: ReturnType<typeof connectDaemon> | undefined;
    try {
      const py = await machine.exec("command -v python3 && python3 --version");
      expect(py.stdout).toContain("Python 3");
      notes.push(`guest ${py.stdout.trim().replace(/\n/g, " ")}`);

      relay = startCallbackRelay({ runtime: rt, builder, log: l => lines.push(l), openUrl: async () => true });
      // The socket the app's sidebar reads: forwards.list on connect, forward.open and forward.close after.
      srv = await serveRuntime(rt, { port: 0, authToken: "live-app", forwards: relay });
      app = await WsClient.connect(srv.port, { token: "live-app" });
      await app.request("events.subscribe");

      const reach = await rt.golden.builderReach(builder.id);
      let out = "";
      let ptyId = "";
      link = connectDaemon({
        previewUrl: reach.url,
        token: reach.daemonToken!,
        heartbeatMs: 10_000,
        onEvent: e => {
          if (e.type === "pty.data") out += e.data;
        },
      });
      await link.ready;
      const created = await link.request("pty.create", { cols: 140, rows: 40 });
      ptyId = String(created["ptyId"]);
      await link.request("pty.attach", { ptyId });
      const type = (s: string) => link!.request("pty.write", { ptyId, data: s });
      const shown = () => strip(out);
      const seen = (re: RegExp, ms: number, what: string) =>
        until(() => re.test(shown()), ms, what).catch((e: Error) => {
          throw new Error(`${e.message}; terminal showed: ${JSON.stringify(shown().slice(-1500))}`);
        });

      const tServe = Date.now();
      await type(`python3 -m http.server ${PORT}\n`);
      await seen(/Serving HTTP on/, 30_000, "http.server's banner");
      await until(() => relay!.forwards().some(f => f.port === PORT), 15_000, `laptop listener on ${PORT}`);
      const banner = shown().split("\n").find(l => l.includes("Serving HTTP on"))?.trim() ?? "";
      notes.push(`terminal: ${banner}; forwarded ${Date.now() - tServe}ms after Enter`);
      await until(() => app!.events.some(e => e.type === "forward.open"), 5_000, "forward.open on the app's socket");
      expect(app.events.find(e => e.type === "forward.open")).toMatchObject({ type: "forward.open", forward: { workspaceId: machine.id, port: PORT, name: "forwards-live (builder)", kind: "url" } });
      const listed = await app.request("forwards.list");
      expect(listed["forwards"]).toMatchObject([{ workspaceId: machine.id, port: PORT }]);
      notes.push(`app socket: forward.open received, forwards.list = ${JSON.stringify(listed["forwards"])}`);

      // A real curl on this Mac, the way a person's browser would dial the printed link.
      const curl = await execFileAsync("curl", ["-s", "-i", "--max-time", "20", `http://127.0.0.1:${PORT}/`]);
      expect(curl.stdout).toContain("HTTP/1.0 200 OK");
      expect(curl.stdout).toContain("Directory listing for /");
      await seen(/GET \/ HTTP\/1\.1" 200/, 10_000, "the guest server's access log line");
      notes.push(`curl http://127.0.0.1:${PORT}/ on this Mac: ${curl.stdout.split("\r\n")[0]}, ${curl.stdout.length} bytes, the guest logged the GET`);

      // Stop from the app: the socket op, then the close event, then the port is free here.
      const stopped = await app.request("forwards.stop", { workspaceId: machine.id, port: PORT });
      expect(stopped.ok).toBe(true);
      await until(() => app!.events.some(e => e.type === "forward.close"), 5_000, "forward.close on the app's socket");
      expect(relay.forwards()).toEqual([]);
      expect((await app.request("forwards.list"))["forwards"]).toEqual([]);
      expect(await refused(PORT)).toBe(true);
      notes.push(`stop: forwards.stop ok, forward.close received, 127.0.0.1:${PORT} refuses connections here`);
      await type("\x03");

      const joined = lines.join("\n");
      expect(joined).not.toContain("http://");
      expect(lines).toContain(`forwards-live (builder): forwarding localhost:${PORT} on this computer to the workspace (closes after 10 min without traffic)`);
      expect(lines).toContain(`forwards-live (builder): stopped forwarding localhost:${PORT} (stopped from the app)`);
      // eslint-disable-next-line no-console
      console.log(`[local-forwards.live]\n  ${notes.join("\n  ")}\n  host lines:\n    ${lines.join("\n    ")}`);
    } finally {
      link?.close();
      app?.close();
      await relay?.close();
      await srv?.close();
      await machine.kill().catch(() => {});
      const gone = await backend.get(machine.id).then(m => m.state(), () => "gone" as const);
      expect(gone).toBe("gone");
      machineId = undefined;
    }
    const alive = (await backend.list()).filter(m => !isReserved(m.labels) && m.labels["wsp-test"] === LABEL["wsp-test"] && m.state !== "gone");
    expect(alive).toEqual([]);
  });
});
