// SPDX-License-Identifier: AGPL-3.0-only
// The composer's row of pickers: the agent and its model, the reasoning, the
// access, and the folder. Base UI's menu and popover never settle
// under jsdom, so both are stood in by a plain open/closed context.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessCatalog, ProjectView, SessionView, WorkspaceView } from "@wsp/protocol";

vi.mock("../ui/menu", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Radio = createContext<{ value: string | null; pick: (value: string) => void }>({ value: null, pick: () => {} });
  const Menu = ({ children }: { children: ReactNode }) => {
    const [open, set] = useState(false);
    return <Ctx.Provider value={{ open, set }}>{children}</Ctx.Provider>;
  };
  const MenuTrigger = ({ children, render: _render, className, ...props }: { children: ReactNode; render?: unknown; className?: string; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return (
      <button type="button" className={className} onClick={() => ctx.set(!ctx.open)} {...(props as Record<string, unknown>)}>
        {children}
      </button>
    );
  };
  const MenuPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="menu">{children}</div> : null);
  const MenuItem = ({ children, onClick, ...props }: { children: ReactNode; onClick?: () => void; [key: string]: unknown }) => (
    <div role="menuitem" onClick={onClick} {...(props as Record<string, unknown>)}>{children}</div>
  );
  const MenuRadioGroup = ({ children, value, onValueChange }: { children: ReactNode; value: string | null; onValueChange: (value: string) => void }) => (
    <Radio.Provider value={{ value, pick: onValueChange }}>
      <div role="group">{children}</div>
    </Radio.Provider>
  );
  const MenuRadioItem = ({ children, value, className: _c, ...props }: { children: ReactNode; value: string; className?: string; [key: string]: unknown }) => {
    const radio = useContext(Radio);
    return (
      <div role="menuitemradio" aria-checked={radio.value === value} onClick={() => radio.pick(value)} {...(props as Record<string, unknown>)}>
        {children}
      </div>
    );
  };
  const MenuGroup = ({ children }: { children: ReactNode }) => <div role="group">{children}</div>;
  const MenuGroupLabel = ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <div data-menu-label {...(props as Record<string, unknown>)}>{children}</div>
  );
  const MenuSeparator = () => <hr />;
  return { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator };
});

vi.mock("../ui/popover", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Popover = ({ children, open, onOpenChange }: { children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
    const [own, setOwn] = useState(false);
    const set = (next: boolean) => {
      setOwn(next);
      onOpenChange?.(next);
    };
    return <Ctx.Provider value={{ open: open ?? own, set }}>{children}</Ctx.Provider>;
  };
  const PopoverTrigger = ({ children, render: _render, className, ...props }: { children: ReactNode; render?: unknown; className?: string; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return (
      <button type="button" className={className} onClick={() => ctx.set(!ctx.open)} {...(props as Record<string, unknown>)}>
        {children}
      </button>
    );
  };
  const PopoverPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="dialog">{children}</div> : null);
  return { Popover, PopoverTrigger, PopoverPopup };
});

import { useStore } from "../../protocol/store";
import { useComposerDraftStore } from "./composerDraftStore";
import { useComposerOptionsStore } from "./composerOptionsStore";
import { ComposerOptionPickers } from "./ComposerOptionPickers";
import type { ChatThreadHandle, ChatThreadView } from "./useChatThread";

const WS = "ws_a";

/** A thread nobody has sent on yet, which is what the composer opens with. */
const view: ChatThreadView = {
  entries: [],
  turns: [],
  latestTurn: null,
  running: false,
  activeTurnStartedAt: null,
  settled: null,
  cwd: null,
  shellCwd: null,
  harness: null,
  model: null,
  agent: null,
  permissionMode: null,
};
const thread = { view, hydrated: true, busy: false, sending: false, fresh: true, thread: undefined, threadKey: WS, named: null } as unknown as ChatThreadHandle;

/** A thread with a turn behind it, as the person meets it when they open one from the sidebar; `recorded` is the
 * thread's record as its transcript carries it, which a thread with no row left still has. */
const ran = (threadKey: string, model: string, recorded: Pick<ChatThreadView, "agent" | "permissionMode"> = { agent: null, permissionMode: null }): ChatThreadHandle =>
  ({
    view: { ...view, entries: [{ id: "e1" } as unknown as ChatThreadView["entries"][number]], model, ...recorded },
    hydrated: true,
    busy: false,
    sending: false,
    fresh: false,
    resume: "sess",
    thread: threadKey,
    threadKey,
    named: null,
  }) as unknown as ChatThreadHandle;

const PROJECT = { id: "pr_1", name: "the-project", path: "/root", computer: "default" };

const WORKSPACE: WorkspaceView = {
  id: WS,
  name: "pricing page",
  machineId: "m1",
  project: PROJECT,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};

const record = (lastAgent?: string): ProjectView =>
  ({
    ...PROJECT,
    source: { kind: "folder", path: "/root" },
    remote: null,
    defaultBranch: null,
    memoryKey: "k",
    memoryDir: "/root",
    createdAt: "2026-09-01T00:00:00Z",
    ...(lastAgent === undefined ? {} : { lastAgent }),
  }) as unknown as ProjectView;

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }],
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }],
  contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
  permissionModes: [{ value: "plan", label: "Plan", description: "Read and plan only" }, { value: "bypassPermissions", label: "Bypass", description: "Run every tool without asking", isDefault: true }],
  steers: true,
  renames: true,
  images: true,
};

const CODEX: HarnessCatalog = {
  ...CLAUDE,
  harness: "codex",
  label: "Codex",
  models: [{ value: "gpt-6-astra", label: "GPT-6 Astra", isDefault: true }],
  permissionModes: [{ value: "read-only", label: "Read only", description: "Reads only" }, { value: "danger-full-access", label: "Full access", description: "Runs every tool without asking", isDefault: true }],
};

function draw(opts: { catalogs?: HarnessCatalog[]; project?: ProjectView; sessions?: SessionView[]; thread?: ChatThreadHandle } = {}) {
  const catalogs = opts.catalogs ?? [CLAUDE];
  useStore.setState({
    conn: "closed",
    workspaces: [WORKSPACE],
    statuses: {},
    sessions: opts.sessions === undefined ? {} : { [WS]: opts.sessions },
    projects: opts.project === undefined ? [] : [opts.project],
    harnesses: catalogs,
    harnessesByWorkspace: { [WS]: catalogs },
  });
  return render(<ComposerOptionPickers workspaceId={WS} thread={opts.thread ?? thread} onPickAccess={() => {}} onOtherFolder={() => {}} />);
}

const reasoning = () => document.querySelector<HTMLElement>('[data-composer-picker="reasoning"]')!;
const access = () => document.querySelector<HTMLElement>('[data-composer-picker="access"]')!;
const model = () => document.querySelector<HTMLElement>('[data-composer-picker="model"]')!;

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
  useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  useStore.setState({ workspaces: [], projects: [], harnesses: [], harnessesByWorkspace: {} });
});

describe("the composer's reasoning and access buttons", () => {
  it("read the picked effort with its window, and the picked access, each its own button after the model with a rule between", () => {
    draw();
    expect(reasoning().textContent).toBe("High 1M");
    expect(reasoning().getAttribute("aria-label")).toBe("Reasoning: High 1M");
    expect(access().textContent).toBe("Bypass");
    expect(access().getAttribute("aria-label")).toBe("Access: Bypass");
    expect([...document.querySelectorAll("[data-composer-picker]")].map(el => el.getAttribute("data-composer-picker"))).toEqual(["model", "reasoning", "access", "project"]);
    // A hairline stands before each of the two, so every picker reads as its own control.
    for (const picker of [reasoning(), access()]) expect(picker.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
  });

  it("holds Reasoning and Context window in one menu and Access in the other, each with the agent's default marked", () => {
    draw();
    fireEvent.click(reasoning());
    const first = screen.getByRole("menu");
    expect(within(first).getAllByText(/^(Reasoning|Context window|Access)$/).map(el => el.textContent)).toEqual(["Reasoning", "Context window"]);
    expect(within(first).getAllByRole("menuitemradio", { checked: true }).map(el => el.getAttribute("data-composer-option"))).toEqual(["high", "1m"]);
    fireEvent.click(reasoning());
    fireEvent.click(access());
    const second = screen.getByRole("menu");
    expect(within(second).getAllByText(/^(Reasoning|Context window|Access)$/).map(el => el.textContent)).toEqual(["Access"]);
    expect(within(second).getAllByRole("menuitemradio", { checked: true }).map(el => el.getAttribute("data-composer-option"))).toEqual(["bypassPermissions"]);
    expect(within(second).getAllByText("default").length).toBe(1);
  });

  it("leaves the reasoning button out for a model with no effort and no window, and keeps the access button", () => {
    draw({ catalogs: [{ ...CLAUDE, efforts: [], contextWindows: [], models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: [] }] }] });
    expect(document.querySelector('[data-composer-picker="reasoning"]')).toBeNull();
    expect(access().textContent).toBe("Bypass");
  });
});

describe("the agent a thread that has run keeps", () => {
  const onCodex = { id: "sC", workspaceId: WS, harness: "codex", status: "completed", model: "gpt-6-astra", effort: "high", permissionMode: "read-only", threadId: "t1" } as SessionView;
  const onClaude = { id: "sK", workspaceId: WS, harness: "claude", status: "running", model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions", threadId: "t9" } as SessionView;

  it("is its own rows', while a thread running beside it is the workspace's newest turn", () => {
    // What the owner saw: a read-only Codex thread whose row of pickers read Claude Code at bypass, because a
    // Claude thread in the same workspace had run after it.
    draw({ catalogs: [CLAUDE, CODEX], sessions: [onCodex, onClaude], thread: ran("t1", "gpt-6-astra") });
    expect(model().dataset["harness"]).toBe("codex");
    expect(model().textContent).toContain("GPT-6 Astra");
    expect(access().dataset["access"]).toBe("read-only");
  });

  it("is Claude's on the Claude thread beside it, read off that thread's own row", () => {
    draw({ catalogs: [CLAUDE, CODEX], sessions: [onCodex, onClaude], thread: ran("t9", "claude-opus-5") });
    expect(model().dataset["harness"]).toBe("claude");
    expect(access().dataset["access"]).toBe("bypassPermissions");
  });

  it("is its own record's where no row of it is left, past the runtime's cap on rows", () => {
    // The runtime's index drops a thread's rows once the workspace holds more than its cap; the transcript keeps the
    // thread and stamps its record on every start. The pickers read that record before any row.
    draw({ catalogs: [CLAUDE, CODEX], sessions: [onClaude], thread: ran("t1", "gpt-6-astra", { agent: "codex", permissionMode: "read-only" }) });
    expect(model().dataset["harness"]).toBe("codex");
    expect(model().textContent).toContain("GPT-6 Astra");
    expect(access().dataset["access"]).toBe("read-only");
  });
});

describe("the agent a fresh thread opens on", () => {
  it("is the one the project remembers", () => {
    draw({ catalogs: [CLAUDE, CODEX], project: record("codex") });
    expect(model().dataset["harness"]).toBe("codex");
  });

  it("is the catalog's first where the project remembers none, and the menu stays shut until the person opens it", () => {
    draw({ catalogs: [CLAUDE, CODEX], project: record() });
    expect(model().dataset["harness"]).toBe("claude");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves the menu shut where the project remembers an agent", () => {
    draw({ catalogs: [CLAUDE, CODEX], project: record("codex") });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open on the agent tab the person picks, so its models can be read", async () => {
    draw({ catalogs: [CLAUDE, CODEX], project: record() });
    fireEvent.click(model());
    const rail = screen.getByRole("dialog");
    fireEvent.click(within(rail).getByRole("tab", { name: "Codex" }));
    // The pick is a reason to read that agent's list, not to take the list away.
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(model().dataset["harness"]).toBe("codex"));
    expect(within(screen.getByRole("dialog")).getByRole("option", { name: /GPT-6 Astra/ })).toBeTruthy();
  });
});
