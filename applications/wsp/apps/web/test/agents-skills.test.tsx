// SPDX-License-Identifier: AGPL-3.0-only
// Skills from the app: a skill's detail draws its SKILL.md under the facts,
// read by the host once, in the renderer's restricted mode; Turn off and on
// and Remove go to the host, Remove only once its confirmation is taken; the
// skill wsp writes and a plugin's offer nothing and a project's is held from
// turning off; Add a skill replaces the list with a search the host sends to
// skills.sh, and a result opens its detail with its SKILL.md before install,
// the agents to put it in and, from a task's panel, the project.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, AgentsTarget, SkillHit, SkillPreview } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS as W, type RowsContext } from "../src/components/agents/agentsRows.js";
import { useSkillActs } from "../src/components/agents/useSkillActs.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { pickOption } from "./select.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");
const SKILL_MD = "---\nname: frontend-design\ndescription: Design frontends\n---\n# Frontend design\n\nPick a bold direction.\n";
const HITS: SkillHit[] = [
  { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 3_612_000 },
  { id: "acme/kit/frontend-design", source: "acme/kit", skillId: "frontend-design", name: "frontend-design", installs: 1_200 },
];

function List({ report = AGENTS_REPORT, ctx = {} }: { report?: AgentsReport; ctx?: Partial<RowsContext> }) {
  const skills = useSkillActs(report.target);
  return <AgentsManager shell="page" head={{ line: "x" }} report={report} reading={false} on="spoo" ctx={{ where: "box", heldWhy: null, ...ctx, ...(skills === undefined ? {} : { skills }) }} onRefresh={() => {}} now={NOW} />;
}

type Settle<T> = { resolve(v: T): void; reject(e: Error): void };

function host(o: { preview?: SkillPreview; searchFails?: string } = {}) {
  const previews: [AgentsTarget, string, boolean][] = [];
  const gets: string[] = [];
  const searches: string[] = [];
  const toggles: [string, boolean, boolean][] = [];
  const removes: string[] = [];
  const adds: [string, readonly string[], boolean][] = [];
  const pending: Settle<void>[] = [];
  const wait = (): Promise<void> => new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  useStore.setState({
    api: {
      skillsPreview: async (target: AgentsTarget, name: string, project: boolean) => (previews.push([target, name, project]), o.preview ?? { text: SKILL_MD, size: SKILL_MD.length }),
      skillsGet: async (skill: string) => (gets.push(skill), { text: "---\nname: pdf\n---\n# pdf\n\nFill forms.\n", size: 40 }),
      skillsSearch: async (q: string) => {
        searches.push(q);
        if (o.searchFails !== undefined) throw new Error(o.searchFails);
        return q === "zzz" ? [] : HITS;
      },
      skillsToggle: async (_t: AgentsTarget, name: string, project: boolean, on: boolean) => (toggles.push([name, project, on]), wait()),
      skillsRemove: async (_t: AgentsTarget, name: string) => (removes.push(name), wait()),
      skillsAdd: async (_t: AgentsTarget, skill: string, agents: readonly string[], project: boolean) => (adds.push([skill, agents, project]), { path: "~/.agents/skills/pdf", agents: [] }),
    } as unknown as Api,
  });
  return { previews, gets, searches, toggles, removes, adds, pending };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const tab = (name: string): void => void fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const rowEl = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agents-row="${key}"]`)!;
const detail = (): HTMLElement => document.querySelector<HTMLElement>("[data-agents-detail]")!;
const openRow = (key: string): HTMLElement => {
  fireEvent.click(rowEl(key).querySelector<HTMLButtonElement>("[data-row-trigger]")!);
  return detail();
};
const acts = (): string[] => [...detail().querySelectorAll<HTMLElement>("[data-detail-acts] button")].map(b => b.textContent ?? "");
const actIn = (id: string): HTMLButtonElement => detail().querySelector<HTMLButtonElement>(`[data-detail-acts] [data-k=act-${id}]`)!;
const typeSearch = (value: string): void => void fireEvent.change(document.querySelector<HTMLInputElement>("[data-k=add-search]")!, { target: { value } });

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a skill's detail", () => {
  it("draws its SKILL.md under the facts, its frontmatter off, read by the host once as the detail opens", async () => {
    const h = host();
    render(<List />);
    tab("Skills");
    openRow("skill-user-frontend-design");
    await settle();
    expect(h.previews).toEqual([[{ placeId: "p_spoo" }, "frontend-design", false]]);
    const body = detail().querySelector<HTMLElement>("[data-k=skill-preview-body]")!;
    expect(body.querySelector("h1")?.textContent).toBe("Frontend design");
    expect(body.textContent).not.toContain("description: Design frontends");
    expect(detail().querySelector("[data-k=skill-preview-cut]")).toBeNull();
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    openRow("skill-user-frontend-design");
    await settle();
    expect(h.previews).toHaveLength(1);
  });

  it("reads the SKILL.md again off the new computer when the target under an open detail changes", async () => {
    const h = host();
    const { rerender } = render(<List />);
    tab("Skills");
    openRow("skill-user-frontend-design");
    await settle();
    rerender(<List report={{ ...AGENTS_REPORT, target: { placeId: "p_other" } }} />);
    await settle();
    expect(h.previews.map(([target]) => target)).toEqual([{ placeId: "p_spoo" }, { placeId: "p_other" }]);
    expect(detail().querySelector("[data-k=skill-preview-body] h1")?.textContent).toBe("Frontend design");
  });

  it("says how much of a long SKILL.md it shows, and the host's sentence where the read was refused", async () => {
    host({ preview: { text: "# big\n", size: 130 * 1024 } });
    render(<List />);
    tab("Skills");
    openRow("skill-user-frontend-design");
    await settle();
    expect(detail().querySelector("[data-k=skill-preview-cut]")?.textContent).toBe("shows the first 64 KB of 130 KB");
    cleanup();
    useStore.setState({ api: { skillsPreview: async () => Promise.reject(new Error("The SKILL.md of pdf could not be read.")) } as unknown as Api });
    render(<List />);
    tab("Skills");
    openRow("skill-user-frontend-design");
    await settle();
    expect(detail().querySelector("[data-k=skill-preview-refused]")?.textContent).toContain("The SKILL.md of pdf could not be read.");
  });

  it("turns a skill off through the host, holds the act while it runs, and reads off on the row and in the detail once the report says so", async () => {
    const h = host();
    const { rerender } = render(<List />);
    tab("Skills");
    openRow("skill-user-frontend-design");
    expect(acts()).toEqual([W.turnOff, W.remove]);
    fireEvent.click(actIn("turn-off"));
    expect(h.toggles).toEqual([["frontend-design", false, false]]);
    expect(actIn("turn-off").disabled).toBe(true);
    await act(async () => h.pending[0]!.resolve());
    const off: AgentsReport = { ...AGENTS_REPORT, skills: AGENTS_REPORT.skills.map(s => (s.name === "frontend-design" ? { ...s, paths: s.paths.map(p => ({ ...p, off: true as const })) } : s)) };
    rerender(<List report={off} />);
    expect(detail().querySelector("[data-fact=status] [data-status-word]")?.textContent).toBe("off");
    expect(acts()).toEqual([W.turnOn, W.remove]);
    fireEvent.click(actIn("turn-on"));
    expect(h.toggles.at(-1)).toEqual(["frontend-design", false, true]);
    await act(async () => h.pending[1]!.reject(new Error("mv: Permission denied")));
    expect(detail().querySelector("[data-k=detail-refused]")?.textContent).toContain("mv: Permission denied");
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    expect(rowEl("skill-user-frontend-design").querySelector("[data-row-word] [data-status-word]")?.textContent).toBe("off");
    expect(rowEl("skill-user-frontend-design").querySelector("[data-row-title]")?.className).toContain("text-foreground/70");
  });

  it("removes a skill only once the confirmation is taken, whose own button is the red one", async () => {
    const h = host();
    render(<List />);
    tab("Skills");
    openRow("skill-user-frontend-design");
    fireEvent.click(actIn("remove"));
    expect(h.removes).toEqual([]);
    expect(await screen.findByText("Remove frontend-design?")).toBeTruthy();
    expect(screen.getByText("Its folder and every link to it leave spoo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: W.cancel }));
    await settle();
    expect(h.removes).toEqual([]);
    fireEvent.click(actIn("remove"));
    const go = await screen.findByRole("button", { name: W.remove, hidden: false });
    const confirm = document.querySelector<HTMLButtonElement>("[data-k=confirm-remove-go]")!;
    expect(confirm).toBe(go);
    expect(confirm.className).toContain("bg-destructive");
    expect(actIn("remove").className).not.toContain("bg-destructive");
    fireEvent.click(confirm);
    expect(h.removes).toEqual(["frontend-design"]);
  });

  it("offers nothing on the skill wsp writes or a plugin's, and holds a project's Turn off with where it lives", async () => {
    const h = host();
    render(<List />);
    tab("Skills");
    openRow("skill-user-wsp");
    expect(acts()).toEqual([]);
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    openRow("skill-plugin-pdf");
    expect(acts()).toEqual([]);
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    openRow("skill-project-pr_wsp-wsp-review");
    expect(actIn("turn-off").disabled).toBe(true);
    expect(detail().querySelector("[data-act-hover=turn-off]")?.getAttribute("title")).toBe("lives in the repo at ~/wsp/.agents/skills/wsp-review");
    fireEvent.click(actIn("turn-off"));
    expect(h.toggles).toEqual([]);
  });
});

describe("Add a skill", () => {
  it("replaces the list with a search the host sends to skills.sh once the person pauses, and never an empty one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = host();
    render(<List />);
    tab("Skills");
    const add = document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(document.querySelector("[data-agents-add] [data-k=detail-title]")?.textContent).toBe(W.addSkill);
    expect(document.activeElement).toBe(document.querySelector("[data-k=add-search]"));
    expect(document.querySelector("[data-k=add-empty]")?.textContent).toBe(W.typeToSearch);
    typeSearch("p");
    typeSearch("pd");
    typeSearch("pdf");
    expect(h.searches).toEqual([]);
    expect(document.querySelector("[data-k=add-reading]")).not.toBeNull();
    await act(async () => void vi.advanceTimersByTime(260));
    await settle();
    expect(h.searches).toEqual(["pdf"]);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-add-row]")];
    expect(rows.map(r => [r.querySelector("[data-add-title]")?.textContent, r.querySelector("[data-add-subtext]")?.textContent, r.querySelector("[data-add-fact]")?.textContent])).toEqual([
      ["pdf", "anthropics/skills", "3.6M"],
      ["frontend-design", "acme/kit", W.installed],
    ]);
    expect(rows[1]!.className).toContain("opacity-60");
    typeSearch("   ");
    await act(async () => void vi.advanceTimersByTime(260));
    expect(h.searches).toEqual(["pdf"]);
    typeSearch("zzz");
    fireEvent.keyDown(document.querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    expect(h.searches).toEqual(["pdf", "zzz"]);
    expect(document.querySelector("[data-k=add-empty]")?.textContent).toBe(W.noHits("zzz"));
  });

  it("says why a search came back with nothing where the host refused it", async () => {
    host({ searchFails: "skills.sh did not answer: getaddrinfo ENOTFOUND skills.sh" });
    render(<List />);
    tab("Skills");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    typeSearch("pdf");
    fireEvent.keyDown(document.querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    expect(document.querySelector("[data-k=add-empty]")?.textContent).toBe("skills.sh did not answer: getaddrinfo ENOTFOUND skills.sh");
  });

  it("opens a result's detail with its SKILL.md off skills.sh before install, the agents to tick, and Install with the picks", async () => {
    const h = host();
    render(<List />);
    tab("Skills");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    typeSearch("pdf");
    fireEvent.keyDown(document.querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-add-row="anthropics/skills/pdf"] [data-row-trigger]')!);
    await settle();
    expect(h.gets).toEqual(["anthropics/skills/pdf"]);
    expect(detail().querySelector("[data-k=detail-title]")?.textContent).toBe("pdf");
    expect([...detail().querySelectorAll<HTMLElement>("[data-fact]")].map(f => (f.querySelector("[data-fact-value]") ?? f.querySelector("[data-status-word]"))?.textContent)).toEqual([W.notInstalled, "anthropics/skills", "3.6M"]);
    expect(detail().querySelector("[data-k=skill-preview-body] h1")?.textContent).toBe("pdf");
    expect(acts()).toEqual(["Install pdf"]);
    // Codex and OpenCode read the shared folder, so they stand ticked and held; Claude Code takes a link of its own.
    const option = (id: string): HTMLElement => detail().querySelector<HTMLElement>(`[data-choice=agents] [data-choice-option=${id}]`)!;
    expect([...detail().querySelectorAll<HTMLElement>("[data-choice=agents] [data-choice-option]")].map(o => o.dataset["choiceOption"])).toEqual(["claude", "codex", "opencode"]);
    expect(option("codex").getAttribute("title")).toBe(W.readsShared);
    expect(detail().querySelector("[data-k=where-pick]")?.textContent).toBe(W.global);
    fireEvent.click(option("claude").querySelector("button,[role=checkbox]")!);
    fireEvent.click(actIn("install"));
    expect(h.adds).toEqual([["anthropics/skills/pdf", [], false]]);
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    expect(document.querySelector("[data-agents-add]")).not.toBeNull();
  });

  it("from a task's panel, asks whether it goes in the project, and a skill already there is held", async () => {
    const h = host();
    render(<List ctx={{ where: "here" }} />);
    tab("Skills");
    fireEvent.click(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!);
    typeSearch("pdf");
    fireEvent.keyDown(document.querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-add-row="anthropics/skills/pdf"] [data-row-trigger]')!);
    await pickOption(detail().querySelector("[data-k=where-pick]")!, /^wsp/);
    fireEvent.click(actIn("install"));
    expect(h.adds).toEqual([["anthropics/skills/pdf", ["claude"], true]]);
    fireEvent.click(detail().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-add-row="acme/kit/frontend-design"] [data-row-trigger]')!);
    expect(detail().querySelector("[data-fact=status] [data-status-word]")?.textContent).toBe(W.installed);
    expect(actIn("install").disabled).toBe(true);
    expect(detail().querySelector("[data-act-hover=install]")?.getAttribute("title")).toBe("already on spoo");
  });

  it("holds Add where the client carries no skills road, and a task on a box holds it for that box's page", () => {
    useStore.setState({ api: {} as unknown as Api });
    render(<List />);
    tab("Skills");
    expect(document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!.disabled).toBe(true);
    cleanup();
    host();
    render(<List ctx={{ where: "box-task", computer: "spoo" }} />);
    tab("Skills");
    const add = document.querySelector<HTMLButtonElement>("[data-k=agents-add]")!;
    expect(add.disabled).toBe(true);
    expect(add.parentElement?.getAttribute("title")).toBe("on spoo's page");
  });
});
