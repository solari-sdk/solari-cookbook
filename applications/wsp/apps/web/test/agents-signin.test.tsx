// SPDX-License-Identifier: AGPL-3.0-only
// Sign in from an agent's or a server's row or detail: the device road
// draws the code the tool printed and Open under the detail's acts, Cancel
// stands first while it runs and stops it on the host, the paste road a field
// whose code goes back to the tool, a failure the tool's own words; a token
// row asks for the paste under the line that mints it; a row that asks the
// person to pick hands them the line for their terminal; Add the wsp tools
// writes on this Mac and is held anywhere else; a report reads again when the
// host says the agents there changed.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, AgentsSignInEvent, AgentsTarget } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS, serverSignInStart, type AgentsWhere } from "../src/components/agents/agentsRows.js";
import { useAgentActs } from "../src/components/agents/useAgentActs.js";
import { forgetAgentsReports, useAgentsReport } from "../src/components/agents/useAgentsReport.js";
import { makeApi, type Api, type ProtocolClient } from "../src/protocol/client.js";
import type { ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");

function List({ where = "box", report = AGENTS_REPORT, typeInTerminal }: { where?: AgentsWhere; report?: AgentsReport; typeInTerminal?: (line: string) => void }) {
  const acts = useAgentActs(report.target);
  return (
    <AgentsManager
      shell="page"
      head={{ line: "x" }}
      report={report}
      reading={false}
      on="spoo"
      ctx={{ where, ...(where === "box" ? { computer: "spoo" } : {}), heldWhy: null, ...(acts === undefined ? {} : { acts }), ...(typeInTerminal === undefined ? {} : { typeInTerminal }) }}
      onRefresh={() => {}}
      now={NOW}
    />
  );
}

interface Started {
  target: AgentsTarget;
  agent: string;
  server: string | undefined;
  step(e: Omit<AgentsSignInEvent, "type" | "signInId">): void;
}

function host(o: { key?: (agent: string, key: string) => Promise<void> } = {}) {
  const started: Started[] = [];
  const codes: [string, string][] = [];
  const keys: [string, string][] = [];
  const added: [AgentsTarget, string][] = [];
  const stopped: string[] = [];
  const offs: string[] = [];
  const agentsSignIn = async (target: AgentsTarget, agent: string, server: string | undefined, onStep: (e: AgentsSignInEvent) => void) => {
    const signInId = `si_${started.length + 1}`;
    started.push({ target, agent, server, step: e => onStep({ type: "agents.signIn", signInId, ...e }) });
    return { signInId, stop: () => void stopped.push(signInId), off: () => void offs.push(signInId) };
  };
  useStore.setState({
    api: {
      agentsSignIn,
      agentsSignInCode: async (id: string, code: string) => void codes.push([id, code]),
      agentsKey: o.key ?? (async (agent: string, key: string) => void keys.push([agent, key])),
      agentsAddTools: async (target: AgentsTarget, agent: string) => (added.push([target, agent]), { file: "~/.config/opencode/opencode.json" }),
    } as unknown as Api,
  });
  return { started, codes, keys, added, stopped, offs };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const rowEl = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agents-row="${id}"]`)!;
const detail = (): HTMLElement => document.querySelector<HTMLElement>("[data-agents-detail]")!;
const openRow = (id: string): HTMLElement => {
  fireEvent.click(rowEl(id).querySelector<HTMLButtonElement>("[data-row-trigger]")!);
  return detail();
};
const back = (): void => void fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
const actIn = (act: string): HTMLButtonElement => detail().querySelector<HTMLButtonElement>(`[data-detail-acts] [data-k=act-${act}]`)!;
const LINEAR = "server-global-linear-http-mcp.linear.app";
const NOTION = "server-global-notion-http-mcp.notion.com";

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
  forgetAgentsReports();
  vi.restoreAllMocks();
});

describe("signing an agent in from its row", () => {
  it("runs a device road from the row's Sign in, opens the detail on the code the tool printed and Open, and waits on the person", async () => {
    const h = host();
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    render(<List />);
    fireEvent.click(rowEl("agent-codex").querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-sign-in]")!);
    await settle();
    expect(h.started.map(s => [s.target, s.agent, s.server])).toEqual([[{ placeId: "p_spoo" }, "codex", undefined]]);
    const flow = detail().querySelector<HTMLElement>("[data-k=sign-in-flow]")!;
    expect(flow).not.toBeNull();
    // A device code is typed on the page, so only the code's line stands, from the press on.
    expect(flow.querySelectorAll("[data-sign-in-line]")).toHaveLength(1);
    // While it runs, Cancel is the next step.
    expect(detail().querySelector("[data-detail-acts] button")?.textContent).toBe(AGENTS_LIST_WORDS.cancel);
    act(() => h.started[0]!.step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false }));
    expect(flow.querySelector("[data-k=sign-in-code]")?.textContent).toBe("ABCD-12345");
    expect(flow.querySelector("[data-k=code-field]")).toBeNull();
    expect(flow.querySelectorAll("[data-sign-in-line]")).toHaveLength(1);
    const openButton = flow.querySelector<HTMLButtonElement>("[data-k=sign-in-open]")!;
    expect(openButton.textContent).toBe("Open");
    expect(openButton.querySelector("svg")).not.toBeNull();
    fireEvent.click(openButton);
    expect(opened).toHaveBeenCalledWith("https://auth.openai.com/codex/device", "_blank", "noopener,noreferrer");
    back();
    expect(rowEl("agent-codex").querySelector("[data-row-status] [data-status-word]")?.textContent).toBe(AGENTS_LIST_WORDS.waitingOnYou);
    openRow("agent-codex");
    act(() => h.started[0]!.step({ state: "signed-in" }));
    expect(detail().querySelector("[data-k=sign-in-flow]")).toBeNull();
  });

  it("keeps the field's line standing from the press for a sign-in whose page hands a code back, through every state it takes", async () => {
    const h = host();
    const coded = { ...AGENTS_REPORT, agents: AGENTS_REPORT.agents.map(a => (a.id === "codex" ? { ...a, signInRoad: "code" as const } : a)) };
    render(<List report={coded} />);
    openRow("agent-codex");
    fireEvent.click(actIn("sign-in"));
    await settle();
    const lines = (): number => detail().querySelectorAll("[data-k=sign-in-flow] [data-sign-in-line]").length;
    expect(lines()).toBe(2);
    act(() => h.started[0]!.step({ state: "waiting", url: "https://auth.openai.com/oauth/authorize", paste: true }));
    expect(detail().querySelector("[data-k=code-field]")).not.toBeNull();
    expect(lines()).toBe(2);
    act(() => h.started[0]!.step({ state: "failed", said: "code expired" }));
    expect(lines()).toBe(2);
    // A start the host refused keeps the same lines too.
    act(() => useStore.setState({ api: { ...useStore.getState().api!, agentsSignIn: async () => Promise.reject(new Error("not connected")) } as unknown as Api }));
    fireEvent.click(actIn("sign-in"));
    await settle();
    expect(detail().querySelector("[data-k=sign-in-refused]")?.textContent).toContain("not connected");
    expect(lines()).toBe(2);
  });

  it("stops a running sign-in on the host from Cancel and drops what it drew, and a step or an answer for it after that is dropped too", async () => {
    const h = host();
    render(<List />);
    openRow("agent-codex");
    fireEvent.click(actIn("sign-in"));
    await settle();
    fireEvent.click(actIn("cancel"));
    expect(h.stopped).toEqual(["si_1"]);
    expect(detail().querySelector("[data-k=sign-in-flow]")).toBeNull();
    expect(actIn("sign-in")).not.toBeNull();
    act(() => h.started[0]!.step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "LATE-00000" }));
    expect(detail().querySelector("[data-k=sign-in-flow]")).toBeNull();
    // Cancelled before the host answered the start: the run it answers with is stopped at once.
    let answer: (v: { signInId: string; stop: () => void; off: () => void }) => void = () => {};
    const late: string[] = [];
    act(() => useStore.setState({ api: { ...useStore.getState().api!, agentsSignIn: () => new Promise(r => (answer = r)) } as unknown as Api }));
    fireEvent.click(actIn("sign-in"));
    fireEvent.click(actIn("cancel"));
    await act(async () => answer({ signInId: "si_late", stop: () => void late.push("si_late"), off: () => {} }));
    expect(late).toEqual(["si_late"]);
    expect(detail().querySelector("[data-k=sign-in-flow]")).toBeNull();
  });

  it("stops a running sign-in from the row's Cancel and leaves the list standing", async () => {
    const h = host();
    render(<List />);
    fireEvent.click(rowEl("agent-codex").querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-sign-in]")!);
    await settle();
    back();
    fireEvent.click(rowEl("agent-codex").querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-cancel]")!);
    expect(h.stopped).toEqual(["si_1"]);
    expect(document.querySelector("[data-agents-detail]")).toBeNull();
    expect(rowEl("agent-codex").querySelector("[data-row-slot] [data-k=act-sign-in]")).not.toBeNull();
  });

  it("stops the sign-in on the host when the target changes or the panel closes, and only stops listening to one that ended", async () => {
    const h = host();
    const { rerender, unmount } = render(<List />);
    const press = async (): Promise<void> => {
      if (document.querySelector("[data-agents-detail]") !== null) back();
      fireEvent.click(rowEl("agent-codex").querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-sign-in]")!);
      await settle();
    };
    await press();
    act(() => h.started[0]!.step({ state: "failed", said: "Not logged in" }));
    expect([h.stopped, h.offs]).toEqual([[], ["si_1"]]);
    await press();
    expect(h.started).toHaveLength(2);
    rerender(<List report={{ ...AGENTS_REPORT, target: { placeId: "p_other" } }} />);
    expect(h.stopped).toEqual(["si_2"]);
    rerender(<List />);
    await press();
    unmount();
    expect(h.stopped).toEqual(["si_2", "si_3"]);
  });

  it("types a code the page handed back into the tool, and a failure says what the tool said", async () => {
    const h = host();
    render(<List />);
    fireEvent.click(screen.getByRole("radio", { name: /^MCP servers/ }));
    fireEvent.click(rowEl(LINEAR).querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-sign-in]")!);
    await settle();
    expect(h.started.map(s => [s.agent, s.server])).toEqual([["claude", "linear"]]);
    act(() => h.started[0]!.step({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true", paste: true }));
    const field = detail().querySelector<HTMLInputElement>("[data-k=code-field]")!;
    // An MCP sign-in has no code: what goes back is the address the browser landed on.
    expect(field.placeholder).toBe("The address your browser landed on");
    expect(field.getAttribute("aria-label")).toBe("linear: The address your browser landed on");
    fireEvent.change(field, { target: { value: " http://localhost:4711/callback?code=x " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(h.codes).toEqual([["si_1", "http://localhost:4711/callback?code=x"]]);
    act(() => h.started[0]!.step({ state: "failed", said: "Authentication failed: invalid code" }));
    expect(detail().querySelector("[data-k=sign-in-refused]")?.textContent).toContain("Authentication failed: invalid code");
  });

  it("asks a token row for the paste under the line that mints it, keeps the host's refusal, and closes once the key is kept", async () => {
    let refuse = true;
    const keys: [string, string][] = [];
    host({
      key: async (agent, key) => {
        if (refuse) throw new Error("That is not a Claude Code token.");
        keys.push([agent, key]);
      },
    });
    // Signed out, since a signed-in agent is offered no Sign in.
    render(<List report={{ ...AGENTS_REPORT, agents: AGENTS_REPORT.agents.map(a => (a.id === "claude" ? { ...a, signIn: "none" as const } : a)) }} />);
    openRow("agent-claude");
    fireEvent.click(actIn("sign-in"));
    const flow = detail().querySelector<HTMLElement>("[data-k=sign-in-flow]")!;
    expect(flow.querySelector("[data-k=sign-in-mint]")?.textContent).toBe("claude setup-token");
    const field = flow.querySelector<HTMLInputElement>("[data-k=sign-in-key]")!;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sk-ant-api03-nope" } });
    const save = flow.querySelector<HTMLButtonElement>("[data-k=sign-in-save]")!;
    expect(save.querySelector("svg")).not.toBeNull();
    fireEvent.click(save);
    await settle();
    expect(flow.querySelector("[data-k=sign-in-refused]")?.textContent).toContain("That is not a Claude Code token.");
    refuse = false;
    fireEvent.change(field, { target: { value: "sk-ant-oat01-ok" } });
    fireEvent.click(flow.querySelector<HTMLButtonElement>("[data-k=sign-in-save]")!);
    await settle();
    expect(keys).toEqual([["claude", "sk-ant-oat01-ok"]]);
    expect(detail().querySelector("[data-k=sign-in-flow]")).toBeNull();
  });

  it("hands a row that asks the person to pick the line for their terminal, and types it into a task's own terminal", async () => {
    const h = host();
    const { unmount } = render(<List />);
    openRow("agent-opencode");
    fireEvent.click(actIn("sign-in"));
    expect(detail().querySelector("[data-k=sign-in-line]")?.textContent).toBe("wsp add spoo --sign-in opencode");
    unmount();
    render(<List where="here" />);
    openRow("agent-opencode");
    fireEvent.click(actIn("sign-in"));
    expect(detail().querySelector("[data-k=sign-in-line]")?.textContent).toBe("wsp agents signin opencode");
    cleanup();
    const typed: string[] = [];
    render(<List where="here" typeInTerminal={line => void typed.push(line)} />);
    openRow("agent-opencode");
    const button = actIn("sign-in");
    // The word is Sign in whatever road it takes; this one types the agent's own sign-in into the task's terminal.
    expect(button.textContent).toBe(AGENTS_LIST_WORDS.signIn);
    fireEvent.click(button);
    expect(typed).toEqual(["opencode auth login"]);
    expect(h.started).toEqual([]);
  });

  it("waits on the browser on this computer, where the harness opens the page and takes the redirect, with the page as a fallback and Cancel", async () => {
    const h = host();
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    render(<List where="here" report={{ ...AGENTS_REPORT, target: { placeId: "here" }, reach: "here" }} />);
    fireEvent.click(screen.getByRole("radio", { name: /^MCP servers/ }));
    fireEvent.click(rowEl(LINEAR).querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-sign-in]")!);
    await settle();
    expect(h.started.map(s => [s.target, s.agent, s.server])).toEqual([[{ placeId: "here" }, "claude", "linear"]]);
    const flow = detail().querySelector<HTMLElement>("[data-k=sign-in-flow]")!;
    expect(flow.querySelector("[data-k=sign-in-browser]")?.textContent).toBe("Finish in your browser");
    expect(flow.querySelector("[data-k=sign-in-open]")).toBeNull();
    expect(detail().querySelector("[data-detail-acts] button")?.textContent).toBe(AGENTS_LIST_WORDS.cancel);
    act(() => h.started[0]!.step({ state: "waiting", url: "https://mcp.linear.app/authorize?client_id=x", paste: false }));
    expect(flow.querySelector("[data-k=sign-in-browser]")?.textContent).toBe("Finish in your browser");
    expect(flow.querySelector("[data-k=code-field]")).toBeNull();
    const page = flow.querySelector<HTMLButtonElement>("[data-k=sign-in-open]")!;
    expect(page.textContent).toBe("Open the page");
    fireEvent.click(page);
    expect(opened).toHaveBeenCalledWith("https://mcp.linear.app/authorize?client_id=x", "_blank", "noopener,noreferrer");
    act(() => h.started[0]!.step({ state: "failed", said: "Authentication failed: access denied" }));
    expect(flow.querySelector("[data-k=sign-in-browser]")).toBeNull();
    expect(detail().querySelector("[data-k=sign-in-refused]")?.textContent).toContain("Authentication failed: access denied");
  });

  it("hands a server whose page returns to localhost on another computer the harness's own line, from that agent's own line in a folded entry", async () => {
    host();
    render(<List />);
    fireEvent.click(screen.getByRole("radio", { name: /^MCP servers/ }));
    openRow(NOTION);
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-fact=config-codex] [data-k=act-sign-in]")!);
    expect(detail().querySelector("[data-k=sign-in-line]")?.textContent).toBe("codex mcp login 'notion'");
    expect(detail().querySelector("[data-k=sign-in-why]")?.textContent).toBe("Its page returns to localhost, which wsp does not carry back to spoo yet. Run this in a terminal on spoo:");
  });

  it("runs a server's sign-in on a joined computer the host relays and waits on the browser, taking the landed address only when the host asks", async () => {
    const h = host();
    render(<List report={{ ...AGENTS_REPORT, reach: "relay" }} />);
    fireEvent.click(screen.getByRole("radio", { name: /^MCP servers/ }));
    openRow(NOTION);
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-fact=config-codex] [data-k=act-sign-in]")!);
    await settle();
    expect(h.started.map(s => [s.target, s.agent, s.server])).toEqual([[AGENTS_REPORT.target, "codex", "notion"]]);
    const flow = detail().querySelector<HTMLElement>("[data-k=sign-in-flow]")!;
    expect(flow.querySelector("[data-k=sign-in-line]")).toBeNull();
    const page = "https://mcp.notion.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fcallback";
    act(() => h.started[0]!.step({ state: "waiting", url: page, paste: false }));
    expect(flow.querySelector("[data-k=sign-in-browser]")?.textContent).toBe("Finish in your browser");
    expect(flow.querySelector("[data-k=sign-in-open]")?.textContent).toBe("Open the page");
    expect(flow.querySelector("[data-k=code-field]")).toBeNull();
    // This computer could not listen on the page's port, so the host asks for the address the browser landed on.
    act(() => h.started[0]!.step({ state: "waiting", url: page, paste: true }));
    const field = flow.querySelector<HTMLInputElement>("[data-k=code-field]")!;
    expect(field.getAttribute("aria-label") ?? field.placeholder).toContain(AGENTS_LIST_WORDS.landedAddress);
  });
});

describe("a server's sign-in road", () => {
  it("is the one the host said the report's page reaches, never worked out again from where the list stands", () => {
    const linear = AGENTS_REPORT.servers.find(r => r.name === "linear")!;
    expect(serverSignInStart(linear, { where: "here", reach: "relay" })).toEqual({ kind: "run", agent: "claude", server: "linear", finish: "callback", pastes: true });
    expect(serverSignInStart(linear, { where: "here", reach: "none" })).toEqual({ kind: "run", agent: "claude", server: "linear", finish: "address", pastes: true });
    expect(serverSignInStart(linear, { where: "here" })).toEqual({ kind: "run", agent: "claude", server: "linear", finish: "address", pastes: true });
  });
});

describe("the wsp tools and the report after a write", () => {
  it("writes the wsp tools into an agent's config on this Mac and holds the act on a box", async () => {
    const h = host();
    const { unmount } = render(<List />);
    openRow("agent-opencode");
    const held = actIn("add-tools");
    expect(held.disabled).toBe(true);
    expect(held.closest("[title]")?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.toolsHereOnly);
    unmount();
    render(<List where="here" report={{ ...AGENTS_REPORT, target: { placeId: "here" } }} />);
    openRow("agent-opencode");
    fireEvent.click(actIn("add-tools"));
    await settle();
    expect(h.added).toEqual([[{ placeId: "here" }, "opencode"]]);
  });

  it("reads a report again when the host says the agents on that target changed, and ignores another target's change", async () => {
    const reads: AgentsTarget[] = [];
    let push: (e: ProtocolEvent) => void = () => {};
    useStore.setState({
      api: {
        agentsRead: async (target: AgentsTarget) => (reads.push(target), { ...AGENTS_REPORT, target }),
        subscribe: (fn: (e: ProtocolEvent) => void) => ((push = fn), () => {}),
      } as unknown as Api,
    });
    function Reader() {
      useAgentsReport({ placeId: "p_spoo" });
      return null;
    }
    render(<Reader />);
    await settle();
    expect(reads).toHaveLength(1);
    act(() => push({ type: "agents.changed", seq: 1, target: { placeId: "p_other" } } as ProtocolEvent));
    await settle();
    expect(reads).toHaveLength(1);
    act(() => push({ type: "agents.changed", seq: 2, target: { placeId: "p_spoo" } } as ProtocolEvent));
    await settle();
    act(() => push({ type: "agents.changed", seq: 3 } as ProtocolEvent));
    await settle();
    expect(reads).toHaveLength(3);
  });
});

describe("the sign-in on the socket", () => {
  it("stop asks the host to end that sign-in and stops listening; off only stops listening", async () => {
    const asked: [string, Record<string, unknown> | undefined][] = [];
    const listeners = new Set<(e: ProtocolEvent) => void>();
    let n = 0;
    const c = {
      request: async (op: string, params?: Record<string, unknown>) => (asked.push([op, params]), op === "agents.signIn" ? { signInId: `si_${++n}` } : {}),
      subscribe: (fn: (e: ProtocolEvent) => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    } as unknown as ProtocolClient;
    const api = makeApi(c);
    const a = await api.agentsSignIn!({ placeId: "p_spoo" }, "codex", undefined, () => {});
    a.off();
    expect(listeners.size).toBe(0);
    const b = await api.agentsSignIn!({ placeId: "p_spoo" }, "codex", undefined, () => {});
    b.stop();
    expect(listeners.size).toBe(0);
    expect(asked.map(([op, p]) => [op, p?.["signInId"]])).toEqual([["agents.signIn", undefined], ["agents.signIn", undefined], ["agents.signInStop", "si_2"]]);
  });
});
