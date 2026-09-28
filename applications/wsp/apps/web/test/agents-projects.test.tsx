// SPDX-License-Identifier: AGPL-3.0-only
// A computer's page covers every project on it: its MCP servers and skills
// stand under Global, then one group per project by name with its folder; a
// server or skill of one name in two projects is two rows; an act on a
// project's row names that project to the host, and the report read again is
// the computer's. A tool's own level lists its parameters. Add an MCP server
// and Add a skill ask where it goes: the home, or one of the projects.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsProject, AgentsReport, AgentsTarget, McpRow, ServerAdd, ServerAsk, ServerToolsAnswer, SkillHit, SkillRow } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS as W } from "../src/components/agents/agentsRows.js";
import { useServerActs } from "../src/components/agents/useServerActs.js";
import { useServerTools } from "../src/components/agents/useServerTools.js";
import { useSkillActs } from "../src/components/agents/useSkillActs.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { pickOption } from "./select.js";

const NOW = Date.parse("2026-09-25T12:03:00.000Z");
const READ_AT = "2026-09-25T12:00:00.000Z";
const APP: AgentsProject = { id: "pr_app", name: "app", path: "~/code/app" };
const WWW: AgentsProject = { id: "pr_www", name: "www", path: "~/code/www" };

const server = (name: string, project?: AgentsProject): McpRow => ({
  agent: "claude",
  name,
  scope: project === undefined ? "user" : "project",
  file: project === undefined ? "~/.claude.json" : `${project.path}/.mcp.json`,
  transport: { kind: "stdio", line: `npx ${name}-mcp` },
  envNames: [],
  auth: "open",
  enabled: true,
  ...(project === undefined ? {} : { project }),
});
const skill = (name: string, project?: AgentsProject): SkillRow => ({
  name,
  scope: project === undefined ? "user" : "project",
  paths: [{ path: project === undefined ? `~/.agents/skills/${name}` : `${project.path}/.claude/skills/${name}`, agent: "claude" }],
  ...(project === undefined ? {} : { project }),
});

const REPORT: AgentsReport = {
  target: { placeId: "p_spoo" },
  home: "/home/ada",
  user: "ada",
  readAt: READ_AT,
  agents: [{ id: "claude", name: "Claude Code", installed: true, version: "2.1.281", road: "own", signIn: "signed-in", signInRoad: "token", wspTools: false }],
  skills: [skill("pdf"), skill("deploy", APP), skill("deploy", WWW)],
  servers: [server("notion"), server("db", WWW), server("db", APP)],
  refused: [],
  projects: [APP, WWW],
};

/** The report read again after a project left the computer. */
const without = (gone: AgentsProject): AgentsReport => ({
  ...REPORT,
  projects: REPORT.projects!.filter(p => p.id !== gone.id),
  skills: REPORT.skills.filter(s => s.project?.id !== gone.id),
  servers: REPORT.servers.filter(s => s.project?.id !== gone.id),
});

function Page({ report = REPORT }: { report?: AgentsReport }) {
  const servers = useServerActs(REPORT.target);
  const skills = useSkillActs(REPORT.target);
  const tools = useServerTools(REPORT.target);
  return (
    <AgentsManager
      shell="page"
      head={{ line: "x" }}
      report={report}
      reading={false}
      on="spoo"
      ctx={{ where: "box", heldWhy: null, ...(servers === undefined ? {} : { servers }), ...(skills === undefined ? {} : { skills }), ...(tools === undefined ? {} : { tools }) }}
      onRefresh={() => {}}
      now={NOW}
    />
  );
}

const PDF: SkillHit = { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 3_612_000 };

function host() {
  const removes: [AgentsTarget, ServerAsk | string][] = [];
  const adds: [AgentsTarget, ServerAdd | string, ...unknown[]][] = [];
  const tools: { target: AgentsTarget; name: string; answer: (a: ServerToolsAnswer) => void }[] = [];
  useStore.setState({
    api: {
      serversAdd: async (target: AgentsTarget, ask: ServerAdd) => (adds.push([target, ask]), { file: "" }),
      skillsSearch: async () => [PDF],
      skillsGet: () => new Promise(() => {}),
      skillsAdd: async (target: AgentsTarget, id: string, agents: readonly string[], project: boolean) => (adds.push([target, id, agents, project]), { path: "", agents: [] }),
      serversRemove: async (target: AgentsTarget, ask: ServerAsk) => void removes.push([target, ask]),
      serversToggle: async () => ({ file: "" }),
      serversTools: (target: AgentsTarget, _agent: string, name: string) => new Promise<ServerToolsAnswer>(answer => tools.push({ target, name, answer })),
      skillsPreview: () => new Promise(() => {}),
      skillsRemove: async (target: AgentsTarget, name: string) => void removes.push([target, name]),
    } as unknown as Api,
  });
  return { removes, adds, tools };
}

const tab = (name: string): void => void fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const groups = (): [string | null, string | null, string[]][] =>
  [...document.querySelectorAll<HTMLElement>("[data-agents-group]")].map(g => [
    g.getAttribute("data-agents-group"),
    g.querySelector("[data-group-label]")?.textContent ?? null,
    [...g.querySelectorAll("[data-agents-row]")].map(r => r.getAttribute("data-agents-row")!),
  ]);
const open = (key: string): HTMLElement => {
  fireEvent.click(document.querySelector<HTMLElement>(`[data-agents-row="${key}"] [data-row-trigger]`)!);
  return document.querySelector<HTMLElement>("[data-agents-detail]")!;
};
const remove = async (detail: HTMLElement): Promise<void> => {
  fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-detail-acts] [data-k=act-remove]")!);
  fireEvent.click(await screen.findByRole("button", { name: W.remove }));
};
/** Picks where an add goes, answering every option the pick offered, each as it reads. */
const pickWhere = (name: string): Promise<string[]> => pickOption(document.querySelector("[data-k=where-pick]")!, new RegExp(`^${name}`));
const whereTrigger = (): string | null | undefined => document.querySelector("[data-k=where-pick]")?.textContent;
const lostLine = (): string | null | undefined => document.querySelector("[data-k=where-pick-lost]")?.textContent;
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a computer's page over its projects", () => {
  it("stands its servers under Global, then each project by name with its folder, one row per project for one name", () => {
    host();
    render(<Page />);
    tab("MCP servers");
    expect(groups()).toEqual([
      ["global", "Global", ["server-global-notion-stdio-npx notion-mcp"]],
      ["project-pr_app", "app~/code/app", ["server-project-pr_app-db-stdio-npx db-mcp"]],
      ["project-pr_www", "www~/code/www", ["server-project-pr_www-db-stdio-npx db-mcp"]],
    ]);
  });

  it("stands its skills by source with one group per project, and the search finds a project by its name", () => {
    host();
    render(<Page />);
    tab("Skills");
    expect(groups()).toEqual([
      ["source-user", "Global", ["skill-user-pdf"]],
      ["project-pr_app", "app~/code/app", ["skill-project-pr_app-deploy"]],
      ["project-pr_www", "www~/code/www", ["skill-project-pr_www-deploy"]],
    ]);
    fireEvent.change(screen.getByPlaceholderText("Search skills"), { target: { value: "www" } });
    expect(groups().flatMap(g => g[2])).toEqual(["skill-project-pr_www-deploy"]);
  });

  it("names the project to the host when a project's server or skill is removed, and the computer alone for the computer's own", async () => {
    const h = host();
    render(<Page />);
    tab("MCP servers");
    await remove(open("server-project-pr_www-db-stdio-npx db-mcp"));
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    await remove(open("server-global-notion-stdio-npx notion-mcp"));
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    tab("Skills");
    await remove(open("skill-project-pr_app-deploy"));
    await settle();
    expect(h.removes).toEqual([
      [{ placeId: "p_spoo", project: "pr_www" }, { agent: "claude", name: "db", scope: "project" }],
      [{ placeId: "p_spoo" }, { agent: "claude", name: "notion", scope: "user" }],
      [{ placeId: "p_spoo", project: "pr_app" }, "deploy"],
    ]);
  });

  it("asks a project's server for its tools in that project, and a tool's own level lists its parameters with their type and whether a call needs them", async () => {
    const h = host();
    render(<Page />);
    tab("MCP servers");
    const detail = open("server-project-pr_app-db-stdio-npx db-mcp");
    fireEvent.click(detail.querySelector<HTMLButtonElement>("[data-detail-acts] [data-k=act-list-tools]")!);
    const db = h.tools.filter(t => t.name === "db");
    expect(db.map(t => [t.target, t.name])).toEqual([[{ placeId: "p_spoo", project: "pr_app" }, "db"]]);
    db[0]!.answer({
      auth: "connected",
      tools: [{ name: "query", description: "Runs one query", params: [{ name: "sql", type: "string", required: true, description: "The query to run" }, { name: "limit", type: "integer", required: false }, { name: "raw", required: false }] }],
      readAt: READ_AT,
    });
    await settle();
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-under-row=query] button")!);
    const level = document.querySelector<HTMLElement>("[data-agents-under-row]")!;
    expect(level.querySelector("[data-k=under-list] h4")?.textContent).toBe(W.parameters);
    expect([...level.querySelectorAll("[data-under-item]")].map(i => [...i.querySelectorAll("span")].map(s => s.textContent))).toEqual([
      ["sqlstring, required", "sql", "string, required", "The query to run"],
      ["limitinteger", "limit", "integer"],
      ["raw", "raw"],
    ]);
  });

  it("adds an MCP server to the home or to the project picked, each by its folder, and names that project to the host", async () => {
    const h = host();
    render(<Page />);
    tab("MCP servers");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    expect(document.querySelector("[data-k=where-pick]")?.textContent).toBe(W.global);
    expect(document.querySelector("[data-k=add-server-file]")?.textContent).toBe("~/.claude.json");
    expect(await pickWhere("www")).toEqual([W.global, "app~/code/app", "www~/code/www"]);
    expect(whereTrigger()).toBe("www~/code/www");
    expect(document.querySelector("[data-k=add-server-file]")?.textContent).toBe("~/code/www/.mcp.json");
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-k=add-server-name]")!, { target: { value: "acme" } });
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-k=add-server-command]")!, { target: { value: "uvx acme" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=add-server-go]")!);
    await settle();
    expect(h.adds).toEqual([[{ placeId: "p_spoo", project: "pr_www" }, { agent: "claude", name: "acme", project: true, command: "uvx", args: ["acme"] }]]);
  });

  it("installs a skill in the home or in the project picked, reading installed off the folder it would go in", async () => {
    const h = host();
    render(<Page />);
    tab("Skills");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-k=add-search]")!, { target: { value: "pdf" } });
    fireEvent.keyDown(document.querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-add-row="anthropics/skills/pdf"] [data-row-trigger]')!);
    const detail = (): HTMLElement => document.querySelector<HTMLElement>("[data-agents-detail]")!;
    const status = (): string | null | undefined => detail().querySelector("[data-fact=status] [data-status-word]")?.textContent;
    expect(status()).toBe(W.installed);
    await pickWhere("app");
    expect(status()).toBe(W.notInstalled);
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-detail-acts] [data-k=act-install]")!);
    await settle();
    expect(h.adds).toEqual([[{ placeId: "p_spoo", project: "pr_app" }, "anthropics/skills/pdf", ["claude"], true]]);
  });

  it("holds Add an MCP server where the project picked left on a read again, naming it, and never falls back to the home", async () => {
    const h = host();
    const { rerender } = render(<Page />);
    tab("MCP servers");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    await pickWhere("www");
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-k=add-server-name]")!, { target: { value: "acme" } });
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-k=add-server-command]")!, { target: { value: "uvx acme" } });
    rerender(<Page report={without(WWW)} />);
    expect(lostLine()).toBe("www is no longer on spoo; pick where it goes.");
    expect(whereTrigger()).not.toContain("pr_www");
    expect(whereTrigger()).not.toContain(W.global);
    expect(document.querySelector("[data-k=add-server-file]")?.textContent).not.toBe("~/.claude.json");
    const go = document.querySelector<HTMLButtonElement>("[data-k=add-server-go]")!;
    expect(go.disabled).toBe(true);
    fireEvent.click(go);
    fireEvent.keyDown(document.querySelector("[data-k=add-server-command]")!, { key: "Enter" });
    await settle();
    expect(h.adds).toEqual([]);
    await pickWhere("app");
    expect(lostLine()).toBeUndefined();
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=add-server-go]")!);
    await settle();
    expect(h.adds).toEqual([[{ placeId: "p_spoo", project: "pr_app" }, { agent: "claude", name: "acme", project: true, command: "uvx", args: ["acme"] }]]);
  });

  it("holds Install where the project picked left on a read again, naming it, and shows no id in the pick", async () => {
    const h = host();
    const { rerender } = render(<Page />);
    tab("Skills");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    fireEvent.change(document.querySelector<HTMLInputElement>("[data-k=add-search]")!, { target: { value: "pdf" } });
    fireEvent.keyDown(document.querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-add-row="anthropics/skills/pdf"] [data-row-trigger]')!);
    await pickWhere("app");
    expect(whereTrigger()).toBe("app~/code/app");
    rerender(<Page report={without(APP)} />);
    expect(lostLine()).toBe("app is no longer on spoo; pick where it goes.");
    expect(whereTrigger()).not.toContain("pr_app");
    expect(whereTrigger()).not.toContain(W.global);
    const install = document.querySelector<HTMLButtonElement>("[data-agents-detail] [data-detail-acts] [data-k=act-install]")!;
    expect(install.disabled).toBe(true);
    fireEvent.click(install);
    await settle();
    expect(h.adds).toEqual([]);
  });
});
