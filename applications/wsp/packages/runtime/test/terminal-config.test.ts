// SPDX-License-Identifier: AGPL-3.0-only
// Over the wire the host's Ghostty reader answers host.terminalConfig for the
// scheme asked for; a server without one refuses the op, as it refuses the
// folder browser.
import type { TerminalConfig } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, serveRuntime, type RuntimeServer } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { wsRequest } from "./ws-client.js";

const CONFIG: TerminalConfig = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: ["Berkeley Mono"], fontSize: 13, palette: Array<null>(16).fill(null), backgroundOpacity: 0.9 };

describe("host.terminalConfig over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it("hands the scheme asked for to the host's reader and answers with its config; absent, the reader is asked with none", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const asked: (string | undefined)[] = [];
    srv = await serveRuntime(rt, {
      port: 0,
      authToken: "t",
      terminalConfig: {
        read: async scheme => {
          asked.push(scheme);
          return CONFIG;
        },
      },
    });
    expect(await wsRequest(srv.port, "t", { op: "host.terminalConfig", scheme: "light" })).toMatchObject({ ok: true, config: CONFIG });
    expect(await wsRequest(srv.port, "t", { op: "host.terminalConfig" })).toMatchObject({ ok: true, config: CONFIG });
    expect(asked).toEqual(["light", undefined]);
  });

  it("a server with no reader refuses the op in one line", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "host.terminalConfig" })).toMatchObject({ ok: false, error: expect.stringContaining("cannot read the terminal config") });
  });
});
