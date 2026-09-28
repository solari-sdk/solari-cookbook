// SPDX-License-Identifier: AGPL-3.0-only
// One bar per sign-in: the store takes only http(s) URLs, keys a page to the
// callback port the daemon named, and drops it when that port stops
// listening, when the host closes its forward, or on Dismiss. The bar names
// the workspace and Open goes through window.open (the desktop shell turns
// that into the default browser).
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setListeners, type FakeListener } from "../../../packages/daemon/test/fake-proc.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { SignInBanner } from "../src/shell/SignInBanner.js";
import { useSignInStore } from "../src/shell/signInStore.js";
import { wireTerminals } from "../src/terminal/wiring.js";
import { startRelayHarness, type RelayHarness } from "./relay-harness.js";

const execFileAsync = promisify(execFile);
const URL_A = "https://dash.example.com/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcb&state=S";
const URL_B = "https://mcp-server.zomato.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A15384%2Fcallback&state=T";
const DEVICE = "https://github.com/login/device";

const view = (id: string, name: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" });

const pages = () => useSignInStore.getState().pages;

beforeEach(() => {
  useSignInStore.setState({ pages: {} });
  useStore.setState({ workspaces: [view("ws1", "task-1"), view("ws2", "task-2")], forwards: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sign-in store", () => {
  it("keeps http(s) pages only, one per callback port and one portless per workspace", () => {
    const { announce } = useSignInStore.getState();
    announce("ws1", URL_A, 8976);
    announce("ws1", URL_B, 15384);
    announce("ws1", DEVICE);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share"]) announce("ws2", url, 9000);
    expect(pages()).toEqual({
      "ws1:8976": { workspaceId: "ws1", url: URL_A, port: 8976 },
      "ws1:15384": { workspaceId: "ws1", url: URL_B, port: 15384 },
      ws1: { workspaceId: "ws1", url: DEVICE },
    });
    // A retried flow on the same port replaces its page instead of stacking a second bar.
    announce("ws1", "HTTPS://EXAMPLE.COM/A", 8976);
    expect(pages()["ws1:8976"]).toEqual({ workspaceId: "ws1", url: "HTTPS://EXAMPLE.COM/A", port: 8976 });
    for (const url of ["https://%", "https://[::1", "https://exa%mple.com/x"]) announce("ws1", url, 8976);
    expect(pages()["ws1:8976"]!.url).toBe("HTTPS://EXAMPLE.COM/A");
  });

  it("a page leaves when its own port stops listening and stays when another port does", () => {
    const { announce, portClosed } = useSignInStore.getState();
    announce("ws1", URL_A, 8976);
    announce("ws1", DEVICE);
    portClosed("ws1", 3000);
    portClosed("ws2", 8976);
    expect(Object.keys(pages())).toEqual(["ws1:8976", "ws1"]);
    portClosed("ws1", 8976);
    expect(Object.keys(pages())).toEqual(["ws1"]);
  });

  it("two sign-ins at once on one workspace clear independently", () => {
    const { announce, portClosed, dismiss } = useSignInStore.getState();
    announce("ws1", URL_A, 8976);
    announce("ws1", URL_B, 15384);
    portClosed("ws1", 15384);
    expect(Object.keys(pages())).toEqual(["ws1:8976"]);
    announce("ws1", URL_B, 15384);
    dismiss("ws1:8976");
    expect(Object.keys(pages())).toEqual(["ws1:15384"]);
  });

  it("the host closing the forward for that port clears the page too", () => {
    useSignInStore.getState().announce("ws1", URL_A, 8976);
    useSignInStore.getState().announce("ws2", URL_A, 8976);
    useStore.getState().applyEvent({ type: "forward.close", workspaceId: "ws1", port: 8976 });
    expect(Object.keys(pages())).toEqual(["ws2:8976"]);
  });

  it("forgetting a workspace drops every page it had", () => {
    const { announce, forget } = useSignInStore.getState();
    announce("ws1", URL_A, 8976);
    announce("ws1", DEVICE);
    announce("ws2", URL_B, 15384);
    forget("ws1");
    expect(Object.keys(pages())).toEqual(["ws2:15384"]);
  });
});

describe("SignInBanner", () => {
  it("a bar for a URL that does not parse renders without throwing and names no host", () => {
    useSignInStore.setState({ pages: { ws1: { workspaceId: "ws1", url: "https://%" } } });
    render(<SignInBanner />);
    expect(screen.getByRole("alert").textContent).toContain("A sign-in page is ready on task-1");
  });

  it("renders nothing with no page waiting", () => {
    render(<SignInBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the workspace, opens the page on click through window.open, and dismisses", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    useSignInStore.getState().announce("ws1", URL_A, 8976);
    useSignInStore.getState().announce("ws2", DEVICE);
    render(<SignInBanner />);
    const bars = screen.getAllByRole("alert");
    expect(bars).toHaveLength(2);
    expect(bars[0]!.textContent).toContain("A sign-in page for dash.example.com is ready on task-1");
    expect(bars[1]!.textContent).toContain("A sign-in page for github.com is ready on task-2");
    // The click is never blind (the host shows), and never leaks the flow (path and query only on hover).
    expect(screen.getByTestId("sign-in-banner").textContent).not.toContain("redirect_uri");
    expect(screen.getByTestId("sign-in-banner").textContent).not.toContain("state=");
    expect(bars[0]!.getAttribute("title")).toBe(URL_A);

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    expect(open).toHaveBeenCalledWith(URL_A, "_blank", "noopener,noreferrer");
    expect(screen.getAllByRole("alert")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("task-2");
    expect(pages()).toEqual({ ws2: { workspaceId: "ws2", url: DEVICE } });
  });

  it("two sign-ins on one workspace are two bars, and Dismiss takes only its own", () => {
    useSignInStore.getState().announce("ws1", URL_A, 8976);
    useSignInStore.getState().announce("ws1", URL_B, 15384);
    render(<SignInBanner />);
    const bars = screen.getAllByRole("alert");
    expect(bars).toHaveLength(2);
    expect(bars[0]!.textContent).toContain("dash.example.com");
    expect(bars[1]!.textContent).toContain("mcp-server.zomato.com");
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[1]!);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("dash.example.com");
    expect(Object.keys(pages())).toEqual(["ws1:8976"]);
  });
});

describe("wiring ties a bar to the daemon channel that announced it", () => {
  let relay: RelayHarness | undefined;
  let dir: string | undefined;
  let unwire: (() => void) | undefined;
  afterEach(async () => {
    unwire?.();
    await relay?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    unwire = relay = dir = undefined;
  });

  const listening = (port: number): FakeListener => ({ port, loopback: true });

  it("a shim post becomes a bar keyed to its callback port, gone when that port stops listening", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-banner-"));
    const sockPath = join(dir, "open.sock");
    relay = await startRelayHarness({ ports: [listening(8976), listening(3000)], daemonArgs: { openSocket: sockPath } });
    const setPorts = (rows: FakeListener[]): void => setListeners(relay!.procRoot, rows);
    const id = relay.workspaceId;
    const key = `${id}:8976`;
    const workspaces = [view(id, "task-1")];
    const api = {
      listWorkspaces: async () => workspaces,
      daemon: relay.api.daemon,
      subscribe: () => () => {},
    } as unknown as Api;
    useStore.setState({ api, workspaces, conn: "live" });
    unwire = wireTerminals(useStore, { heartbeatMs: 60_000 });
    const deadline = Date.now() + 5000;
    while (pages()[key] === undefined) {
      if (Date.now() > deadline) throw new Error("no bar within 5 s");
      await execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", URL_A, "http://wsp/open"]);
      await new Promise(r => setTimeout(r, 100));
    }
    expect(pages()).toEqual({ [key]: { workspaceId: id, url: URL_A, port: 8976 } });

    // Another listener going away is not this sign-in ending.
    setPorts([listening(8976)]);
    await new Promise(r => setTimeout(r, 250));
    expect(Object.keys(pages())).toEqual([key]);

    // The callback fired and its listener closed: the daemon's port.close ends the bar with it.
    setPorts([]);
    const gone = Date.now() + 5000;
    while (pages()[key] !== undefined) {
      if (Date.now() > gone) throw new Error("bar outlived its port");
      await new Promise(r => setTimeout(r, 25));
    }
    expect(pages()).toEqual({});

    // A workspace that is gone takes its bars with it instead of leaving one under an id.
    useSignInStore.getState().announce(id, DEVICE);
    useStore.setState({ workspaces: [] });
    expect(pages()).toEqual({});
  }, 20_000);
});
