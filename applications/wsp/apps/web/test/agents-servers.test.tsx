// SPDX-License-Identifier: AGPL-3.0-only
// MCP servers from the app: Add an MCP server replaces the list with a form
// whose values are masked and ride once to the host, the file it lands in at
// its foot; Turn off and on go to the host for every agent a server is set up
// for, held where an agent keeps no switch per server; Remove goes only once
// its confirmation is taken, naming every file it leaves; the host's refusal
// stands in the detail or under the form.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, unclosedQuoteRefusal, type AgentsReport, type AgentsTarget, type ServerAdd, type ServerAsk } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS as W, type RowsContext } from "../src/components/agents/agentsRows.js";
import { useServerActs } from "../src/components/agents/useServerActs.js";
import { resetServerIcons } from "../src/components/agents/useServerIcon.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { pickOption } from "./select.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");
const SERVER = { airtable: "server-global-airtable-stdio-npx -y airtable-mcp-server", github: "server-global-github-stdio-npx -y @modelcontextprotocol/server-github", notion: "server-global-notion-http-mcp.notion.com", sentry: "server-global-sentry-http-mcp.sentry.dev" };

function List({ report = AGENTS_REPORT, ctx = {} }: { report?: AgentsReport; ctx?: Partial<RowsContext> }) {
  const servers = useServerActs(report.target);
  return <AgentsManager shell="panel" head={{ computer: "spoo" }} report={report} reading={false} on="spoo" ctx={{ where: "box", heldWhy: null, ...ctx, ...(servers === undefined ? {} : { servers }) }} onRefresh={() => {}} now={NOW} />;
}

type Settle = { resolve(v: { file: string }): void; reject(e: Error): void };

function host() {
  const adds: [AgentsTarget, ServerAdd][] = [];
  const removes: ServerAsk[] = [];
  const toggles: [ServerAsk, boolean][] = [];
  const pending: Settle[] = [];
  const wait = (): Promise<{ file: string }> => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  useStore.setState({
    api: {
      serversAdd: async (target: AgentsTarget, ask: ServerAdd) => (adds.push([target, ask]), wait()),
      serversRemove: async (_t: AgentsTarget, ask: ServerAsk) => (removes.push(ask), wait()),
      serversToggle: async (_t: AgentsTarget, ask: ServerAsk, on: boolean) => (toggles.push([ask, on]), wait()),
    } as unknown as Api,
  });
  return { adds, removes, toggles, pending };
}

const tab = (name: string): void => void fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const rowEl = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agents-row="${key}"]`)!;
const detail = (): HTMLElement => document.querySelector<HTMLElement>("[data-agents-detail]")!;
const openRow = (key: string): HTMLElement => {
  fireEvent.click(rowEl(key).querySelector<HTMLButtonElement>("[data-row-trigger]")!);
  return detail();
};
const actIn = (id: string): HTMLButtonElement => detail().querySelector<HTMLButtonElement>(`[data-detail-acts] [data-k=act-${id}]`)!;
const field = (k: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`[data-k=${k}]`)!;
const type = (k: string, value: string): void => void fireEvent.change(field(k), { target: { value } });
const fields = (k: string): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>(`[data-k=${k}]`)];
const go = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=add-server-go]")!;
const openForm = (): void => {
  tab("MCP servers");
  fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
};

afterEach(() => {
  cleanup();
  resetServerIcons();
  useStore.setState({ api: null, preferences: DEFAULT_PREFERENCES });
});

describe("Server icons", () => {
  const NOTION = "data:image/png;base64,iVBORw0KGgo=";
  function icons(answers: Record<string, string | null>) {
    const asked: [string, boolean][] = [];
    useStore.setState({ api: { serversIcon: async (host: string, refresh?: boolean) => (asked.push([host, refresh === true]), answers[host] ?? null) } as unknown as Api });
    return asked;
  }
  const iconIn = (el: HTMLElement): HTMLImageElement | null => el.querySelector<HTMLImageElement>("[data-k=lead-box] img[data-k=server-icon]");
  const settle = (): Promise<void> => act(async () => void (await new Promise(r => setTimeout(r, 0))));

  it("draws a remote server's own icon off the host in its row and its detail, asks once per host, and keeps the glyph for a command server", async () => {
    const asked = icons({ "mcp.notion.com": NOTION });
    render(<List />);
    tab("MCP servers");
    await settle();
    expect(iconIn(rowEl(SERVER.notion))?.getAttribute("src")).toBe(NOTION);
    expect(iconIn(rowEl(SERVER.sentry))).toBeNull();
    expect(rowEl(SERVER.sentry).querySelector("[data-k=lead-box] svg")).not.toBeNull();
    expect(iconIn(rowEl(SERVER.airtable))).toBeNull();
    expect(asked.map(([h]) => h).sort()).toEqual(["mcp.linear.app", "mcp.notion.com", "mcp.sentry.dev"]);
    const d = openRow(SERVER.notion);
    await settle();
    expect(iconIn(d)?.getAttribute("src")).toBe(NOTION);
    expect(asked).toHaveLength(3);
  });

  it("asks the host again with refresh after Read again", async () => {
    const asked = icons({ "mcp.notion.com": NOTION });
    render(<List />);
    tab("MCP servers");
    await settle();
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-read-again]")!);
    await settle();
    expect(asked.filter(([h]) => h === "mcp.notion.com")).toEqual([
      ["mcp.notion.com", false],
      ["mcp.notion.com", true],
    ]);
    expect(iconIn(rowEl(SERVER.notion))?.getAttribute("src")).toBe(NOTION);
  });

  it("asks nothing and draws every glyph while the person has server icons off, and drops a drawn icon the moment they turn it off", async () => {
    const asked = icons({ "mcp.notion.com": NOTION });
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, serverIcons: false } });
    render(<List />);
    tab("MCP servers");
    await settle();
    expect(asked).toEqual([]);
    expect(document.querySelectorAll("img[data-k=server-icon]")).toHaveLength(0);
    act(() => useStore.setState({ preferences: DEFAULT_PREFERENCES }));
    await settle();
    expect(iconIn(rowEl(SERVER.notion))?.getAttribute("src")).toBe(NOTION);
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, serverIcons: false } }));
    expect(document.querySelectorAll("img[data-k=server-icon]")).toHaveLength(0);
  });
});

describe("Add an MCP server", () => {
  it("replaces the list with its form, focus on the name, the file it lands in following the agent, and Add held until it can go", () => {
    host();
    render(<List />);
    openForm();
    expect(document.querySelector("[data-agents-add-form] [data-k=detail-title]")?.textContent).toBe(W.addServer);
    expect(document.activeElement).toBe(field("add-server-name"));
    expect(document.querySelector("[data-agents-rows]")).toBeNull();
    expect(document.querySelector("[data-k=add-server-agent]")?.textContent).toContain("Claude Code");
    expect(document.querySelector("[data-k=add-server-file]")?.textContent).toBe("~/.claude.json");
    expect(go().disabled).toBe(true);
    type("add-server-name", "acme");
    expect(go().disabled).toBe(true);
    type("add-server-command", "npx -y @acme/mcp");
    expect(go().disabled).toBe(false);
  });

  it("sends a command split into its words with its variables, whose values are masked and ride this once, then goes back to the list", async () => {
    const h = host();
    render(<List />);
    openForm();
    type("add-server-name", " acme ");
    type("add-server-command", "npx -y '@acme/mcp server'");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=add-server-pair-add]")!);
    type("add-server-pair-name", "ACME_KEY");
    type("add-server-pair-value", "sk-acme-x");
    expect(field("add-server-pair-value").type).toBe("password");
    expect(document.body.textContent).not.toContain("sk-acme-x");
    fireEvent.click(go());
    expect(h.adds).toEqual([[AGENTS_REPORT.target, { agent: "claude", name: "acme", command: "npx", args: ["-y", "@acme/mcp server"], env: { ACME_KEY: "sk-acme-x" } }]]);
    expect(go().textContent).toBe(W.adding);
    expect(go().disabled).toBe(true);
    await act(async () => h.pending[0]!.resolve({ file: "~/.claude.json" }));
    expect(document.querySelector("[data-agents-add-form]")).toBeNull();
    expect(document.querySelector("[data-agents-rows]")).not.toBeNull();
  });

  it("sends an address with its headers for the agent picked, and a new name for a header's value never shows", async () => {
    const h = host();
    render(<List />);
    openForm();
    await pickOption(document.querySelector("[data-k=add-server-agent]")!, "Codex");
    expect(document.querySelector("[data-k=add-server-file]")?.textContent).toBe("~/.codex/config.toml");
    type("add-server-name", "acme");
    fireEvent.click(screen.getByRole("radio", { name: W.byAddress }));
    expect(field("add-server-command")).toBeNull();
    type("add-server-url", "https://mcp.acme.example/mcp");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=add-server-pair-add]")!);
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=add-server-pair-add]")!);
    const [first, second] = fields("add-server-pair-name");
    fireEvent.change(first!, { target: { value: "Authorization" } });
    fireEvent.change(fields("add-server-pair-value")[0]!, { target: { value: "Bearer tok-x" } });
    fireEvent.change(second!, { target: { value: "X-Drop" } });
    fireEvent.click(document.querySelectorAll<HTMLButtonElement>("[data-k=add-server-pair-drop]")[1]!);
    fireEvent.keyDown(field("add-server-url"), { key: "Enter" });
    expect(h.adds).toEqual([[AGENTS_REPORT.target, { agent: "codex", name: "acme", url: "https://mcp.acme.example/mcp", headers: { Authorization: "Bearer tok-x" } }]]);
  });

  it("from a task's panel puts it in the project's own file when the person says so", async () => {
    const h = host();
    render(<List />);
    openForm();
    await pickOption(document.querySelector("[data-k=where-pick]")!, /^wsp/);
    expect(document.querySelector("[data-k=add-server-file]")?.textContent).toBe("~/wsp/.mcp.json");
    type("add-server-name", "acme");
    type("add-server-command", "uvx acme");
    fireEvent.click(go());
    expect(h.adds[0]![1]).toEqual({ agent: "claude", name: "acme", project: true, command: "uvx", args: ["acme"] });
  });

  it("refuses a command with an unclosed quote and two variables of one name without sending, saying why under it", () => {
    const h = host();
    render(<List />);
    openForm();
    type("add-server-name", "acme");
    type("add-server-command", 'npx "unclosed');
    fireEvent.click(go());
    expect(document.querySelector("[data-k=add-server-refused]")?.textContent).toBe(unclosedQuoteRefusal);
    type("add-server-command", "npx acme");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=add-server-pair-add]")!);
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=add-server-pair-add]")!);
    const [a, b] = fields("add-server-pair-name");
    fireEvent.change(a!, { target: { value: "KEY" } });
    fireEvent.change(b!, { target: { value: " KEY " } });
    fireEvent.click(go());
    expect(document.querySelector("[data-k=add-server-refused]")?.textContent).toBe(W.twoPairsOneName("command"));
    expect(h.adds).toEqual([]);
  });

  it("keeps the form and its values where the host refused, saying why under it", async () => {
    const h = host();
    render(<List />);
    openForm();
    type("add-server-name", "airtable");
    type("add-server-command", "npx x");
    fireEvent.click(go());
    await act(async () => h.pending[0]!.reject(new Error("airtable is already in ~/.claude.json, so nothing was written; remove it first or pick another name.")));
    expect(document.querySelector("[data-k=add-server-refused]")?.textContent).toBe("airtable is already in ~/.claude.json, so nothing was written; remove it first or pick another name.");
    expect(field("add-server-name").value).toBe("airtable");
    expect(go().disabled).toBe(false);
  });

  it("says so where no agent there keeps servers, and is not offered on a copy of the image or where acts are held", () => {
    host();
    const bare: AgentsReport = { ...AGENTS_REPORT, agents: AGENTS_REPORT.agents.filter(a => a.id === "pi") };
    render(<List report={bare} />);
    openForm();
    expect(document.querySelector("[data-k=add-server-none]")?.textContent).toBe(W.noServerAgents("spoo"));
    cleanup();
    render(<List ctx={{ heldWhy: "away" }} />);
    tab("MCP servers");
    expect(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!.disabled).toBe(true);
    cleanup();
    render(<List ctx={{ where: "fork", editImage: () => {} }} />);
    tab("MCP servers");
    expect(document.querySelector("[data-k=agents-add]")?.getAttribute("aria-label")).toBe(W.editImage);
  });
});

describe("Turn off, turn on and Remove", () => {
  it("turns a server off through the host where its agent keeps a switch, holding the act while it runs, and says a refusal in the detail", async () => {
    const h = host();
    render(<List />);
    tab("MCP servers");
    openRow(SERVER.github);
    fireEvent.click(actIn("turn-off"));
    expect(h.toggles).toEqual([[{ agent: "opencode", name: "github", scope: "user" }, false]]);
    expect(actIn("turn-off").disabled).toBe(true);
    await act(async () => h.pending[0]!.reject(new Error("~/.config/opencode/opencode.json changed while wsp was writing it, so nothing was written; try again.")));
    expect(detail().querySelector("[data-k=detail-refused]")?.textContent).toContain("changed while wsp was writing it");
    expect(actIn("turn-off").disabled).toBe(false);
  });

  it("turns an off server on from its row, and holds Turn off on Claude Code, which keeps no switch per server", () => {
    const h = host();
    render(<List />);
    tab("MCP servers");
    fireEvent.click(rowEl(SERVER.sentry).querySelector<HTMLButtonElement>("[data-k=act-turn-on]")!);
    expect(h.toggles).toEqual([[{ agent: "codex", name: "sentry", scope: "user" }, true]]);
    expect(detail().querySelector("[data-k=detail-title]")?.textContent).toBe("sentry");
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    openRow(SERVER.airtable);
    expect(actIn("turn-off").disabled).toBe(true);
    expect(detail().querySelector("[data-act-hover=turn-off]")?.getAttribute("title")).toBe(W.noSwitch("Claude Code"));
  });

  it("removes a server only once the confirmation is taken, from every file it is set up in, one agent after another", async () => {
    const h = host();
    render(<List />);
    tab("MCP servers");
    openRow(SERVER.notion);
    fireEvent.click(actIn("remove"));
    expect(h.removes).toEqual([]);
    expect(await screen.findByText("Remove notion?")).toBeTruthy();
    expect(screen.getByText("It leaves ~/.codex/config.toml and ~/.claude.json on spoo.")).toBeTruthy();
    const confirm = document.querySelector<HTMLButtonElement>("[data-k=confirm-remove-go]")!;
    expect(confirm.className).toContain("bg-destructive");
    expect(actIn("remove").className).not.toContain("bg-destructive");
    fireEvent.click(confirm);
    expect(h.removes).toEqual([{ agent: "codex", name: "notion", scope: "user" }]);
    await act(async () => h.pending[0]!.resolve({ file: "~/.codex/config.toml" }));
    expect(h.removes).toEqual([
      { agent: "codex", name: "notion", scope: "user" },
      { agent: "claude", name: "notion", scope: "user" },
    ]);
  });
});
