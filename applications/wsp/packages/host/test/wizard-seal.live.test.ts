// SPDX-License-Identifier: AGPL-3.0-only
// A builder with a pty attached over a live daemon link still reads gone from
// the provider once golden.seal returns; a builder that outlives its seal
// bills and eats the second Starter slot. Nothing but poc-labelled
// machines may be left on the account afterwards.
import { SolariBackend, isReserved, type MachineState } from "@wsp/engine";
import { connectDaemon, createRuntime, memoryStore } from "@wsp/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv, sleep } from "../../engine/test/live.js";
import { goldenRecipe } from "../src/cli.js";

const LABEL = { wsp: "1", "wsp-test": "wizard-seal-live" };

const short = (id: string): string => `${id.slice(0, 24)}..${id.slice(-8)}`;

describe.runIf(LIVE)("wizard seal with a live daemon link (live)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  /** Every provider write is logged with its status so a kill that "succeeds" without killing shows up. */
  const wire: string[] = [];
  const loggingFetch: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const t = Date.now();
    const res = await fetch(input, init);
    if (method !== "GET") wire.push(`${new Date().toISOString()} ${method} ${path.replace(/\/sandboxes\/([^/]+)/, (_, id: string) => `/sandboxes/${short(decodeURIComponent(id))}`)} -> ${res.status} (${Date.now() - t}ms)`);
    return res;
  };
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY, fetch: loggingFetch }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  const stateOf = async (id: string): Promise<MachineState> =>
    backend.get(id).then(m => m.state()).catch((e: unknown) => ((e as { kind?: string }).kind === "missing" ? "gone" : Promise.reject(e)));

  it("the builder is gone the moment seal returns, with a pty attached over its daemon link", { timeout: 900_000 }, async () => {
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: {},
      goldenRecipe: { ...goldenRecipe(), labels: LABEL },
    });
    const stages: string[] = [];
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") stages.push(`${e.stage}${e.detail !== undefined ? `:${e.detail}` : ""}`);
    });

    const view = await rt.golden.prepare();
    const builderId = view.id;
    let sealed: Awaited<ReturnType<typeof rt.golden.seal>> | undefined;
    let link: ReturnType<typeof connectDaemon> | undefined;
    const observed: string[] = [];
    try {
      const reach = await rt.golden.builderReach(builderId);
      expect(reach.daemonToken).toBeDefined();
      const linkStatus: string[] = [];
      link = connectDaemon({ previewUrl: reach.url, token: reach.daemonToken!, onEvent: () => {}, onStatus: s => linkStatus.push(`${new Date().toISOString()} ${s}`) });
      await link.ready;
      const created = await link.request("pty.create", { cols: 80, rows: 24 });
      await link.request("pty.attach", { ptyId: String(created["ptyId"]) });
      await link.request("pty.write", { ptyId: String(created["ptyId"]), data: "echo attached\n" });

      const t1 = Date.now();
      sealed = await rt.golden.seal(builderId);
      const tSeal = Date.now() - t1;

      const at0 = await stateOf(builderId);
      const list0 = (await backend.list()).filter(m => m.labels["wsp-test"] === LABEL["wsp-test"]).map(m => `${short(m.id)}=${m.state}`);
      observed.push(`t+0s   get(builder).state=${at0} list=[${list0.join(", ")}]`);
      await sleep(30_000);
      const at30 = await stateOf(builderId);
      const list30 = (await backend.list()).filter(m => m.labels["wsp-test"] === LABEL["wsp-test"]).map(m => `${short(m.id)}=${m.state}`);
      observed.push(`t+30s  get(builder).state=${at30} list=[${list30.join(", ")}]`);

      // eslint-disable-next-line no-console
      console.log(
        `[wizard-seal.live] builder=${short(builderId)} seal=${tSeal}ms\n  stages: ${stages.join(" > ")}\n` +
          `  wire:\n    ${wire.join("\n    ")}\n  link: ${linkStatus.join(", ")}\n  ${observed.join("\n  ")}`,
      );
      expect(sealed.version).toMatchObject({ version: 1, kind: "sandbox", smoke: { exitCode: 0 } });
      expect(at0, "builder still on the provider after seal returned").toBe("gone");
      expect(at30).toBe("gone");
    } finally {
      link?.close();
      await backend.get(builderId).then(m => m.kill()).catch(() => {});
      if (sealed) await backend.deleteSnapshot(sealed.version.snapshotId).catch(() => {});
    }

    const alive = (await backend.list()).filter(m => !isReserved(m.labels) && m.state !== "gone");
    expect(alive).toEqual([]);
  });
});
