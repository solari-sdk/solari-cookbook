// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THIS_COMPUTER, type HarnessCatalog } from "@wsp/protocol";

// Base UI mounts a tooltip's popup only on a real hover, which jsdom does not give it; the stand-in draws it where
// it is written, so what a person reads on the rail is readable here.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => cloneElement(element, {}, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

import { ComposerModelPicker, UNLISTED_MODEL_LINE, agentAndModelLine, listModels } from "./ComposerModelPicker";
import { useComposerFavouritesStore } from "./composerFavouritesStore";

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [
    { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] },
    { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [] },
  ],
  efforts: [],
  contextWindows: [],
  permissionModes: [],
  steers: true,
  renames: true,
  images: true,
};

const CODEX: HarnessCatalog = { ...CLAUDE, harness: "codex", label: "Codex", models: [] };

const FABLE = { value: "claude-fable-5-1", label: "claude-fable-5-1" };

const button = () => screen.getByRole("button", { name: agentAndModelLine(CLAUDE, FABLE) });

function open() {
  return act(async () => fireEvent.click(button()));
}

describe("ComposerModelPicker", () => {
  afterEach(cleanup);

  it("lists a model the thread runs on that the catalog does not carry, under its own id", () => {
    expect(listModels(CLAUDE, [], "", FABLE).map(m => m.value)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"]);
    expect(listModels(CLAUDE, [], "", { value: "claude-opus-5", label: "Opus 5" }).map(m => m.value)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(listModels(CLAUDE, [], "", null).map(m => m.value)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(listModels(CLAUDE, [], "fable", FABLE).map(m => m.value)).toEqual(["claude-fable-5-1"]);
  });

  it("names that model on the button and gives it a muted row that picks like any other", async () => {
    const picked: string[] = [];
    render(<ComposerModelPicker catalogs={[CLAUDE]} catalog={CLAUDE} model={FABLE} pinned where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={(_h, m) => picked.push(m)} />);
    expect(button().textContent).toContain("claude-fable-5-1");
    await open();
    const row = screen.getByRole("option", { name: /claude-fable-5-1/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
    // The row is the name alone, muted; the menu draws no line under a model's name.
    expect(row.textContent).not.toContain(UNLISTED_MODEL_LINE);
    expect(row.querySelector("[data-unlisted-model] .text-muted-foreground")?.textContent).toBe("claude-fable-5-1");
    await act(async () => fireEvent.click(row));
    expect(picked).toEqual(["claude-fable-5-1"]);
  });

  it("names the model on the button beside the agent's mark, which says the agent", () => {
    render(<ComposerModelPicker catalogs={[CLAUDE, CODEX]} catalog={CLAUDE} model={CLAUDE.models[0]!} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Opus 5" });
    expect(trigger.textContent).toBe("Opus 5");
    expect(trigger.querySelector('svg[data-harness-mark="claude"]')).not.toBeNull();
  });

  it("names the agent rather than standing empty while no model is resolved", () => {
    render(<ComposerModelPicker catalogs={[CODEX]} catalog={CODEX} model={null} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={() => {}} />);
    expect(screen.getByRole("button", { name: "Codex" }).textContent).toBe("Codex");
  });

  it("draws each model row as its name with the agent's mark and name under it, and the catalog's default tagged", async () => {
    render(<ComposerModelPicker catalogs={[CLAUDE]} catalog={CLAUDE} model={CLAUDE.models[1]!} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sonnet 5" })));
    const opus = screen.getByRole("option", { name: /Opus 5/ });
    expect(opus.textContent).toContain("default");
    expect(opus.querySelector('svg[data-harness-mark="claude"]')).not.toBeNull();
    expect(opus.textContent).toContain("Claude Code");
    expect(opus.textContent).not.toContain("claude-opus-5");
    expect(screen.getByRole("option", { name: /Sonnet 5/ }).textContent).not.toContain("default");
  });

  it("lists the starred models alone on the favourites tab, and says how to keep one there while none is", async () => {
    useComposerFavouritesStore.setState({ keys: [] });
    render(<ComposerModelPicker catalogs={[CLAUDE, CODEX]} catalog={CLAUDE} model={CLAUDE.models[0]!} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Opus 5" })));
    const tab = document.querySelector<HTMLElement>("[data-composer-favourites-tab]")!;
    expect(tab.getAttribute("aria-selected")).toBe("false");
    await act(async () => fireEvent.click(tab));
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("listbox").textContent).toBe("Star a model to keep it here.");
    // Back on the agent's own tab, a star moves the model onto the favourites tab.
    await act(async () => fireEvent.click(document.querySelector<HTMLElement>('[data-composer-harness="claude"]')!));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Sonnet 5 to favourites" })));
    await act(async () => fireEvent.click(tab));
    expect(screen.getAllByRole("option").map(o => o.dataset["composerOption"])).toEqual(["claude-sonnet-5"]);
    useComposerFavouritesStore.setState({ keys: [] });
  });

  const LEGACY: HarnessCatalog = {
    ...CLAUDE,
    legacyModels: [
      { value: "claude-opus-4-6", label: "Opus 4.6", efforts: [], contextWindows: [] },
      { value: "claude-sonnet-4-5", label: "Sonnet 4.5", efforts: [], contextWindows: [] },
    ],
  };
  const shown = () => screen.queryAllByRole("option").map(o => o.dataset["composerOption"]);
  const fold = () => document.querySelector<HTMLElement>("[data-composer-legacy-fold]");

  it("keeps the older models under a closed Legacy models row at the end, open after one click", async () => {
    useComposerFavouritesStore.setState({ keys: [] });
    const picked: string[] = [];
    render(<ComposerModelPicker catalogs={[LEGACY]} catalog={LEGACY} model={LEGACY.models[0]!} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={(_h, m) => picked.push(m)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Opus 5" })));
    expect(shown()).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(fold()?.textContent).toBe("Legacy models");
    expect(fold()?.getAttribute("aria-expanded")).toBe("false");
    // The fold is the last row, and outside every listbox, which holds options alone.
    expect(fold()?.nextElementSibling).toBeNull();
    expect(fold()?.closest('[role="listbox"]')).toBeNull();
    await act(async () => fireEvent.click(fold()!));
    expect(fold()?.getAttribute("aria-expanded")).toBe("true");
    expect(shown()).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-opus-4-6", "claude-sonnet-4-5"]);
    expect(screen.getByRole("listbox", { name: "Legacy models" }).children).toHaveLength(2);
    for (const box of screen.getAllByRole("listbox")) expect([...box.children].every(c => c.getAttribute("role") === "option")).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("option", { name: /Opus 4\.6/ })));
    expect(picked).toEqual(["claude-opus-4-6"]);
  });

  it("finds a legacy model by search and shows it without the fold", async () => {
    render(<ComposerModelPicker catalogs={[LEGACY]} catalog={LEGACY} model={LEGACY.models[0]!} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Opus 5" })));
    await act(async () => fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: "sonnet" } }));
    expect(shown()).toEqual(["claude-sonnet-5", "claude-sonnet-4-5"]);
    expect(fold()).toBeNull();
    expect(listModels(LEGACY, [], "4.6", null).map(m => m.value)).toEqual(["claude-opus-4-6"]);
  });

  it("opens the fold by keyboard, and stands open when the composer already names a legacy model", async () => {
    const picked: string[] = [];
    render(<ComposerModelPicker catalogs={[LEGACY]} catalog={LEGACY} model={LEGACY.legacyModels![1]!} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={(_h, m) => picked.push(m)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sonnet 4.5" })));
    expect(fold()?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("option", { name: /Sonnet 4\.5/ }).getAttribute("aria-selected")).toBe("true");
    const menu = document.querySelector<HTMLElement>("[data-composer-model-menu]")!;
    for (let i = 0; i < 2; i++) await act(async () => fireEvent.keyDown(menu, { key: "ArrowDown" }));
    expect(fold()?.dataset["active"]).toBe("true");
    await act(async () => fireEvent.keyDown(menu, { key: "Enter" }));
    expect(fold()?.getAttribute("aria-expanded")).toBe("false");
    expect(shown()).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    await act(async () => fireEvent.keyDown(menu, { key: "Enter" }));
    await act(async () => fireEvent.keyDown(menu, { key: "ArrowDown" }));
    await act(async () => fireEvent.keyDown(menu, { key: "Enter" }));
    expect(picked).toEqual(["claude-opus-4-6"]);
  });

  it("stars a legacy model onto the favourites tab and to the top of the agent's own list", async () => {
    useComposerFavouritesStore.setState({ keys: [] });
    render(<ComposerModelPicker catalogs={[LEGACY]} catalog={LEGACY} model={LEGACY.models[0]!} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Opus 5" })));
    await act(async () => fireEvent.click(fold()!));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Opus 4.6 to favourites" })));
    expect(shown()).toEqual(["claude-opus-4-6", "claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-5"]);
    await act(async () => fireEvent.click(document.querySelector<HTMLElement>("[data-composer-favourites-tab]")!));
    expect(shown()).toEqual(["claude-opus-4-6"]);
    expect(fold()).toBeNull();
    useComposerFavouritesStore.setState({ keys: [] });
  });

  it("says each rail row's agent in text a person sees, not only in an attribute", async () => {
    render(<ComposerModelPicker catalogs={[CLAUDE, CODEX]} catalog={CLAUDE} model={FABLE} pinned={false} where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={() => {}} />);
    await open();
    for (const entry of [CLAUDE, CODEX]) {
      const said = document.querySelector(`[data-composer-harness="${entry.harness}"]`)?.nextElementSibling;
      expect(said?.getAttribute("role")).toBe("tooltip");
      expect(said?.textContent).toBe(entry.label);
    }
    // The rail's own name is read out to a person too, and the word the code uses for an agent is not one.
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Agents");
  });
});
