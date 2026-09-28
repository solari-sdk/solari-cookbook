// SPDX-License-Identifier: AGPL-3.0-only
// A server's state and tools over the real hook: the MCP servers tab asks
// each of the person's own servers once when it shows them, each row reading
// checking until its answer brings the state and the tool count together;
// opening the tools reads that same answer and asks nothing, so no row's
// status moves; a project's server is asked on List tools, which opens the
// tools at once; a server that did not answer says why and Reconnect asks
// again; nothing is asked while the computer is away.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsTarget, ServerToolsAnswer } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS as W } from "../src/components/agents/agentsRows.js";
import { useServerTools } from "../src/components/agents/useServerTools.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT, SERVER_TOOLS } from "./fixtures/agents-report.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");
const READ_AT = "2026-09-24T12:00:00.000Z";
const AIRTABLE = "server-global-airtable-stdio-npx -y airtable-mcp-server";
const GITHUB = "server-global-github-stdio-npx -y @modelcontextprotocol/server-github";
const LINEAR = "server-global-linear-http-mcp.linear.app";
const METRICS = "server-project-pr_wsp-spoo-metrics-stdio-node scripts/metrics-mcp.js --token ${METRICS_TOKEN}";

function List({ heldWhy = null, where = "here" }: { heldWhy?: string | null; where?: "here" | "box" }) {
  const tools = useServerTools(AGENTS_REPORT.target);
  return <AgentsManager shell="page" head={{ line: "x" }} report={AGENTS_REPORT} reading={false} on="spoo" ctx={{ where, heldWhy, ...(tools === undefined ? {} : { tools }) }} onRefresh={() => {}} now={NOW} />;
}

type Ask = { target: AgentsTarget; agent: string; name: string; refresh: boolean | undefined; answer: (a: ServerToolsAnswer) => void; refuse: (e: Error) => void };

function host(): Ask[] {
  const asks: Ask[] = [];
  const serversTools = (target: AgentsTarget, agent: string, name: string, refresh?: boolean): Promise<ServerToolsAnswer> =>
    new Promise((answer, refuse) => asks.push({ target, agent, name, refresh, answer, refuse }));
  useStore.setState({ api: { serversTools } as unknown as Api });
  return asks;
}

/** What each server's own host answers: airtable its three tools, github late, linear a sign-in, the rest one tool. */
const ANSWERS: Readonly<Record<string, ServerToolsAnswer>> = {
  airtable: SERVER_TOOLS["airtable"]!,
  github: SERVER_TOOLS["github"]!,
  linear: { auth: "needs-sign-in", holder: "claude", readAt: READ_AT },
};
const answerAll = async (asks: readonly Ask[]): Promise<void> => {
  for (const a of asks) a.answer(ANSWERS[a.name] ?? { auth: "connected", tools: [{ name: "search" }], readAt: READ_AT });
  await settle();
};

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const serversTab = (): void => void fireEvent.click(screen.getByRole("radio", { name: /^MCP servers/ }));
const open = (key: string): HTMLElement => {
  fireEvent.click(document.querySelector<HTMLElement>(`[data-agents-row="${key}"] [data-row-trigger]`)!);
  return document.querySelector<HTMLElement>("[data-agents-detail]")!;
};
const button = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-agents-detail] [data-k=act-${id}]`)!;
const said = (b: Element | null): string => [b?.querySelector("[data-status-word]")?.textContent, b?.querySelector("[data-status-count]")?.textContent].filter(w => w !== undefined).join(" ");
const badge = (): HTMLElement => document.querySelector<HTMLElement>("[data-agents-detail] [data-fact=status] [data-k=status]")!;
/** Every row's status as the list draws it, by the row's key. */
const statuses = (): Record<string, string> =>
  Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-agents-row]")].map(r => [r.dataset["agentsRow"], `${r.querySelector<HTMLElement>("[data-k=status]")?.dataset["state"]} ${said(r.querySelector("[data-k=status]"))}`]));
const back = (): void => void fireEvent.click(document.querySelector<HTMLButtonElement>("[data-agents-manager] [data-k=agents-back]")!);

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a server's state and tools", () => {
  it("are asked once for each of the person's own servers when the tab shows them, each row checking until its answer brings the state and the tool count together", async () => {
    const asks = host();
    render(<List />);
    expect(asks).toEqual([]);
    serversTab();
    expect(asks.map(a => [a.target, a.agent, a.name, a.refresh])).toEqual([
      [{ placeId: "p_spoo" }, "claude", "airtable", false],
      [{ placeId: "p_spoo" }, "opencode", "github", false],
      [{ placeId: "p_spoo" }, "claude", "linear", false],
      [{ placeId: "p_spoo" }, "codex", "notion", false],
      [{ placeId: "p_spoo" }, "claude", "notion", false],
      [{ placeId: "p_spoo" }, "claude", "wsp", false],
    ]);
    const checking = statuses();
    expect(checking[AIRTABLE]).toBe("checking checking");
    // A project's server and one turned off are not asked.
    expect(checking[METRICS]).toBe("open no sign-in needed");
    expect(checking["server-global-sentry-http-mcp.sentry.dev"]).toBe("off off");
    await answerAll(asks);
    expect(statuses()[AIRTABLE]).toBe("connected connected 3 tools");
    expect(statuses()[GITHUB]).toBe("failed failed");
    expect(statuses()[LINEAR]).toBe("needs-sign-in needs sign-in");
  });

  it("starts no command server by itself on a joined computer: its row reads not checked with a grey dot and Check, which checks that one server", async () => {
    const asks = host();
    render(<List where="box" />);
    serversTab();
    // Only the addresses are asked; a command there would be a process started on that computer.
    expect(asks.map(a => [a.agent, a.name])).toEqual([
      ["claude", "linear"],
      ["codex", "notion"],
      ["claude", "notion"],
    ]);
    for (const key of [AIRTABLE, GITHUB, "server-global-wsp-stdio-wsp mcp"]) {
      expect(statuses()[key], key).toBe("unknown not checked");
      expect(document.querySelector(`[data-agents-row="${key}"] [data-status-dot]`)?.className, key).toContain("bg-foreground/30");
    }
    const check = document.querySelector<HTMLButtonElement>(`[data-agents-row="${AIRTABLE}"] [data-row-slot] [data-k=act-check]`)!;
    expect(check.textContent).toBe(W.check);
    fireEvent.click(check);
    expect(asks.slice(3).map(a => [a.agent, a.name, a.refresh])).toEqual([["claude", "airtable", false]]);
    expect(document.querySelector("[data-agents-detail]"), "Check checks in place").toBeNull();
    expect(statuses()[AIRTABLE]).toBe("checking checking");
    await answerAll(asks.slice(3));
    expect(statuses()[AIRTABLE]).toBe("connected connected 3 tools");
    expect(statuses()[GITHUB]).toBe("unknown not checked");
    open(GITHUB);
    expect(document.querySelector("[data-agents-detail] [data-detail-acts] button")?.textContent).toBe(W.check);
  });

  it("opening a server's tools asks nothing and leaves every row's status as it was", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    const before = statuses();
    const asked = asks.length;
    const detail = open(AIRTABLE);
    // One press opens the tools: whichever act the detail leads its tools with.
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-k=act-view-tools], [data-k=act-list-tools]")!);
    await answerAll(asks.slice(asked));
    // Where a first press only counted the tools, the second is the one that opens them.
    if (document.querySelector("[data-agents-under]") === null) fireEvent.click(button("view-tools"));
    back();
    back();
    expect(statuses()).toEqual(before);
    expect(asks).toHaveLength(asked);
    open(AIRTABLE);
    fireEvent.click(button("view-tools"));
    expect(document.querySelectorAll("[data-agents-under] [data-under-row]")).toHaveLength(3);
  });

  it("lists a project server's tools in one press, opening the tools at once while its host is asked", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    open(METRICS);
    expect(button("list-tools").closest("[title]")?.getAttribute("title")).toBe(W.startsOnce);
    fireEvent.click(button("list-tools"));
    expect(asks.at(-1)).toMatchObject({ agent: "claude", name: "spoo-metrics", refresh: false });
    const level = document.querySelector<HTMLElement>("[data-agents-under]")!;
    expect(level.querySelectorAll("[data-k=under-skeleton]")).toHaveLength(3);
    asks.at(-1)!.answer({ auth: "connected", tools: [{ name: "query", description: "Run a query" }, { name: "tables" }], readAt: READ_AT });
    await settle();
    expect([...document.querySelectorAll("[data-agents-under] [data-under-row]")].map(t => t.textContent)).toEqual(["queryRun a query", "tables"]);
    const again = document.querySelector<HTMLButtonElement>("[data-agents-under] [data-k=under-again]")!;
    expect(again.getAttribute("aria-label")).toBe(W.readAgain);
    expect(again.closest("[title]")?.getAttribute("title")).toBe("read 3 min ago");
    fireEvent.click(again);
    expect(asks.at(-1)).toMatchObject({ name: "spoo-metrics", refresh: true });
    // The last answer stands while the next one runs.
    expect(document.querySelectorAll("[data-agents-under] [data-under-row]")).toHaveLength(2);
  });

  it("says why a server did not answer, its status failed with that reason as its hover, and Reconnect asks again; a refusal from the host the same", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    open(GITHUB);
    expect(document.querySelector("[data-k=detail-refused]")?.textContent).toBe("Did not answer in 20 s.");
    expect(said(badge())).toBe("failed");
    expect(badge().getAttribute("title")).toBe("Did not answer in 20 s.");
    expect(document.querySelector("[data-fact=status] [data-fact-note]")?.textContent).toBe("Did not answer in 20 s.");
    fireEvent.click(button("reconnect"));
    expect(asks.at(-1)).toMatchObject({ name: "github", refresh: true });
    asks.at(-1)!.refuse(new Error("spoo is not answering"));
    await settle();
    expect(document.querySelector("[data-k=detail-refused]")?.textContent).toBe("spoo is not answering");
  });

  it("offers Sign in first and no List tools where a sign-in is needed, and names the harness that keeps a sign-in on View tools' hover", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    open(LINEAR);
    expect(document.querySelector("[data-agents-detail] [data-detail-acts] button")?.textContent).toBe(W.signIn);
    expect(document.querySelector("[data-agents-detail] [data-k=act-list-tools]")).toBeNull();
    cleanup();
    const again = host();
    render(<List />);
    serversTab();
    for (const a of again) a.answer(a.name === "airtable" ? { auth: "signed-in", holder: "claude", readAt: READ_AT } : { auth: "connected", readAt: READ_AT });
    await settle();
    open(AIRTABLE);
    expect(said(badge())).toBe(W.signedIn);
    expect(button("view-tools").closest("[title]")?.getAttribute("title")).toBe(W.holdsSignIn("Claude Code"));
  });

  it("asks nothing while the computer is away, and holds List tools where the client cannot ask", () => {
    const asks = host();
    render(<List heldWhy="away 5 min" />);
    serversTab();
    expect(asks).toEqual([]);
    expect(statuses()[AIRTABLE]).toBe("open no sign-in needed");
    open(AIRTABLE);
    fireEvent.click(button("list-tools"));
    expect(asks).toEqual([]);
    expect(button("list-tools").closest("[title]")?.getAttribute("title")).toBe("away 5 min");
    cleanup();
    useStore.setState({ api: {} as unknown as Api });
    render(<List />);
    serversTab();
    open(AIRTABLE);
    expect(button("list-tools").disabled).toBe(true);
  });
});
