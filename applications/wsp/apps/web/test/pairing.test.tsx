// SPDX-License-Identifier: AGPL-3.0-only
// What a page does with what the host inlined: dial this origin's WS_PATH, and
// find a token of its own, since no page carries the host's: the shell's over
// the bridge, the code wsp init put in the address, this browser's store, or
// the code a person types off wsp host pair.
import { createServer, type Server } from "node:http";
import { createRuntime, memoryStore, serveRuntime, type RuntimeServer } from "@wsp/runtime";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openingHash, WS_PATH, type BootPayload } from "@wsp/protocol";
import { BootGate } from "../src/BootGate.js";
import { PAIR_HEADING } from "../src/PairScreen.js";
import { DEVICE_TOKEN_KEY, deviceName, redeemPairingCode, runtimeUrl, storedDeviceToken } from "../src/protocol/pairing.js";
import { stubBackend } from "../../../packages/runtime/test/stub-backend.js";

/** The page as the host serves it on its own computer: the digest of its token, never the token. */
const boot = (over: Partial<BootPayload> = {}): BootPayload => ({ wsPort: 4410, wsPath: WS_PATH, paired: true, version: "0.0.0", tokenHash: "a".repeat(64), ...over });

let srv: RuntimeServer | undefined;
let http: Server | undefined;
afterEach(async () => {
  window.localStorage.clear();
  window.location.hash = "";
  delete window.wsp;
  await srv?.close();
  srv = undefined;
  if (http !== undefined) await new Promise<void>(done => http!.close(() => done()));
  http = undefined;
});

/** A real host-shaped pair: an HTTP server with the runtime answering upgrades of WS_PATH on its own port. */
async function serving(): Promise<{ port: number; hostToken: string; runtime: ReturnType<typeof createRuntime> }> {
  const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
  http = createServer((_req, res) => res.end("page"));
  await new Promise<void>(done => http!.listen(0, "127.0.0.1", done));
  srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", attach: http, devices: runtime.devices });
  return { port: (http.address() as { port: number }).port, hostToken: "host-token", runtime };
}

/** A code minted the way wsp host pair and wsp init mint one: over a socket holding the host's own token. */
async function codeFrom(port: number, here = false): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  await new Promise<void>(done => ws.addEventListener("open", () => done()));
  const ask = (frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise(done => {
      ws.addEventListener("message", e => done(JSON.parse(String(e.data)) as Record<string, unknown>), { once: true });
      ws.send(JSON.stringify(frame));
    });
  await ask({ id: 1, op: "auth", token: "host-token" });
  const issued = await ask({ id: 2, op: "pair.issue", ...(here ? { here: true } : {}) });
  ws.close();
  return issued["code"] as string;
}

const AT = (port: number) => ({ protocol: "http:", host: `127.0.0.1:${port}` });
const mount = (b: BootPayload, port: number) => render(<BootGate boot={b} at={AT(port)} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);

describe("where the page dials", () => {
  it("dials this page's own origin and path, over ws or wss as the page was served", () => {
    expect(runtimeUrl(boot(), { protocol: "http:", host: "127.0.0.1:14400" })).toBe("ws://127.0.0.1:14400/ws");
    expect(runtimeUrl(boot(), { protocol: "https:", host: "box.example.com" })).toBe("wss://box.example.com/ws");
  });

  it("holds only the token this browser was handed, under this host's origin", () => {
    expect(storedDeviceToken(window.localStorage)).toBeUndefined();
    window.localStorage.setItem(DEVICE_TOKEN_KEY, "device-token");
    expect(storedDeviceToken(window.localStorage)).toBe("device-token");
  });

  it("names this browser by its platform and the host it reached, so wsp host devices has a row worth reading", () => {
    expect(deviceName({ protocol: "http:", host: "box:4400" }, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("a Mac in a browser at box:4400");
  });
});

describe("redeeming a code over the page's own socket", () => {
  it("hands back a token the host then takes on an auth frame", async () => {
    const { port } = await serving();
    const code = await (async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
      await new Promise<void>(done => ws.addEventListener("open", () => done()));
      const ask = (frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
        new Promise(done => ws.addEventListener("message", e => done(JSON.parse(String(e.data)) as Record<string, unknown>), { once: true }));
      const authed = ask({});
      ws.send(JSON.stringify({ id: 1, op: "auth", token: "host-token" }));
      await authed;
      const issued = ask({});
      ws.send(JSON.stringify({ id: 2, op: "pair.issue" }));
      const answer = await issued;
      ws.close();
      return answer["code"] as string;
    })();
    const token = await redeemPairingCode(`ws://127.0.0.1:${port}${WS_PATH}`, code, "a browser");
    expect(typeof token).toBe("string");
    expect(token).not.toBe("host-token");
  });

  it("rejects with the host's own words on a code it is not holding", async () => {
    const { port } = await serving();
    await expect(redeemPairingCode(`ws://127.0.0.1:${port}${WS_PATH}`, "AAAAAAAA", "a browser")).rejects.toThrow(/pairing code/);
  });
});

describe("the screen a page with no token shows", () => {
  it("asks for a code, and keeps the token it buys in this browser", async () => {
    const { port } = await serving();
    const host = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    await new Promise<void>(done => host.addEventListener("open", () => done()));
    const ask = (): Promise<Record<string, unknown>> => new Promise(done => host.addEventListener("message", e => done(JSON.parse(String(e.data)) as Record<string, unknown>), { once: true }));
    const authed = ask();
    host.send(JSON.stringify({ id: 1, op: "auth", token: "host-token" }));
    await authed;
    const issued = ask();
    host.send(JSON.stringify({ id: 2, op: "pair.issue" }));
    const code = (await issued)["code"] as string;
    host.close();

    render(<BootGate boot={boot({ tokenHash: undefined, wsPort: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    expect(screen.getByText(PAIR_HEADING)).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: code } });
      fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    });
    await waitFor(() => expect(storedDeviceToken(window.localStorage)).toBeDefined());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });

  it("shows the host's refusal on a code it will not take, and stays on the screen", async () => {
    const { port } = await serving();
    render(<BootGate boot={boot({ tokenHash: undefined, wsPort: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "AAAAAAAA" } });
      fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/pairing code/);
    expect(screen.getByText(PAIR_HEADING)).toBeTruthy();
    expect(storedDeviceToken(window.localStorage)).toBeUndefined();
  });

  it("keeps this browser's token when the page unmounts, and drops it only when the host refuses it", async () => {
    const { port } = await serving();
    window.localStorage.setItem(DEVICE_TOKEN_KEY, "a-token-this-host-never-minted");
    const page = render(
      <BootGate boot={boot({ tokenHash: undefined, wsPort: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />,
    );
    // The client's own close on unmount is not the host refusing anything: a token dropped here would send every
    // remount back to the code screen.
    await act(async () => {
      page.unmount();
    });
    expect(storedDeviceToken(window.localStorage)).toBe("a-token-this-host-never-minted");

    // The host refusing it is the one thing that drops it, and the page goes back to asking for a code.
    render(<BootGate boot={boot({ tokenHash: undefined, wsPort: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await waitFor(() => expect(storedDeviceToken(window.localStorage)).toBeUndefined());
    expect(screen.getByText(PAIR_HEADING)).toBeTruthy();
  });

  it("a host restart under the shell is healed by asking it again, not by the code screen", async () => {
    const { port } = await serving();
    // The shell reads the token file at every call, so a page holding the token the host minted before it restarted
    // gets the new one the moment it asks again. The stale one stands for what the shell held before the restart.
    const held = ["a-token-the-restarted-host-refuses", "host-token"];
    const asked: number[] = [];
    window.wsp = {
      hostToken: async () => {
        asked.push(asked.length);
        return held.shift() ?? "host-token";
      },
    };
    try {
      render(<BootGate boot={boot({ tokenHash: undefined, wsPort: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
      // Two asks: the first token the host refuses, and the one it is serving now.
      await waitFor(() => expect(asked).toHaveLength(2), { timeout: 5_000 });
      await waitFor(() => expect(screen.queryByTestId?.("booting") ?? null).toBeNull());
      expect(screen.queryByText(PAIR_HEADING)).toBeNull();
    } finally {
      delete window.wsp;
    }
  });

  it("a shell whose token the host keeps refusing ends on the code screen rather than asking for ever", async () => {
    const { port } = await serving();
    const asked: number[] = [];
    window.wsp = {
      hostToken: async () => {
        asked.push(asked.length);
        return "a-token-this-host-never-minted";
      },
    };
    try {
      render(<BootGate boot={boot({ tokenHash: undefined, wsPort: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
      expect(await screen.findByText(PAIR_HEADING, undefined, { timeout: 5_000 })).toBeTruthy();
      // The one token the shell holds was asked about once and refused once: nothing loops on it.
      expect(asked.length).toBeLessThanOrEqual(2);
    } finally {
      delete window.wsp;
    }
  });

});

describe("this computer's own page", () => {
  it("in the shell asks the bridge for the token and never shows the pair screen, whatever the page carries", async () => {
    const { port } = await serving();
    const asked: number[] = [];
    window.wsp = {
      hostToken: async () => {
        asked.push(asked.length);
        return "host-token";
      },
    };
    mount(boot(), port);
    await waitFor(() => expect(asked).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("[data-k=booting]")).toBeNull());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });

  it("in a browser spends the code wsp init put in its address, keeps the token it bought, and writes the address back without the code", async () => {
    const { port, runtime } = await serving();
    const code = await codeFrom(port, true);
    window.location.hash = openingHash(code, "ws_first");
    mount(boot(), port);
    await waitFor(() => expect(storedDeviceToken(window.localStorage)).toBeDefined());
    await waitFor(() => expect(document.querySelector("[data-k=booting]")).toBeNull());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
    // The workspace stays in the address; the code does not, so a reload spends nothing and the app never reads it.
    expect(window.location.hash).toBe("#w/ws_first");
    // The device is the owner's browser, listed as such.
    expect((await runtime.devices.list()).map(d => [d.name, d.here])).toEqual([["a Mac in a browser at 127.0.0.1:" + String(port), true]]);
  });

  it("in a browser with a spent or made up code in its address ends on the pair screen, with the code gone from the address", async () => {
    const { port } = await serving();
    window.location.hash = openingHash("AAAAAAAA");
    mount(boot(), port);
    expect(await screen.findByText(PAIR_HEADING)).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(storedDeviceToken(window.localStorage)).toBeUndefined();
  });

  it("in a browser holding no token and given no code shows the pair screen, and a code from wsp host pair lets it in as a device", async () => {
    const { port, runtime } = await serving();
    mount(boot(), port);
    expect(await screen.findByText(PAIR_HEADING)).toBeTruthy();
    const code = await codeFrom(port);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: code } });
      fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    });
    await waitFor(() => expect(storedDeviceToken(window.localStorage)).toBeDefined());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
    expect((await runtime.devices.list()).map(d => d.here)).toEqual([undefined]);
  });

  it("in a browser whose token the host refuses forgets it and asks for a code, on this computer's page as on any other", async () => {
    const { port } = await serving();
    window.localStorage.setItem(DEVICE_TOKEN_KEY, "a-token-this-host-never-minted");
    mount(boot(), port);
    await waitFor(() => expect(storedDeviceToken(window.localStorage)).toBeUndefined());
    expect(screen.getByText(PAIR_HEADING)).toBeTruthy();
  });
});
