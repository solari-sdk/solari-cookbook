// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCatalogProbe } from "@wsp/adapter-claude";
import { CLAUDE_CODE, THREAD_AGENTS } from "@wsp/catalog";
import { HarnessCatalog, catalogSourceLine, effortsFor, everyModel, workspaceAccess, listedPick, markedDefault, modelOf, noModelsLine, OVER_SSH, startPicks, THIS_COMPUTER, type HarnessCatalogProbe } from "@wsp/protocol";
import { HARNESS_CATALOGS, catalogFromProbe, harnessCatalog, smallestModel } from "../src/harness-catalog.js";

describe("harness catalogs", () => {
  it("names every harness the recipe collects, each parsing as the wire type with at most one default per picker", () => {
    expect(HARNESS_CATALOGS.map(c => c.harness)).toEqual(["claude", "codex", "gemini", "opencode", "pi", "hermes"]);
    for (const catalog of HARNESS_CATALOGS) {
      expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
      expect(catalog.source).toBe("table");
      expect(catalog.refusal).toBeUndefined();
      for (const list of [everyModel(catalog), catalog.efforts, catalog.contextWindows, catalog.permissionModes]) {
        expect(list.filter(o => o.isDefault).length).toBeLessThanOrEqual(1);
        expect(new Set(list.map(o => o.value)).size).toBe(list.length);
      }
      expect((catalog.legacyModels ?? []).some(m => m.isDefault)).toBe(false);
    }
  });

  it("every agent wsp can run stands in with its own models, its own pin and its own binary in the footer, never another agent's", () => {
    for (const id of THREAD_AGENTS) {
      const table = harnessCatalog(id)!;
      // The bug this walks: a tab whose binary never answered showed no model and another agent's pin.
      expect(table.models.length).toBeGreaterThan(0);
      expect(table.version).toMatch(/^\S+ \d+\.\d+\.\d+, \d{4}-\d{2}-\d{2}$/);
      const line = catalogSourceLine(table, THIS_COMPUTER);
      expect(line).toBe(`${id} table, ${table.version!}`);
      // One line at the popup's width: 48 characters of the 10px mono the footer draws in (measured in Chromium).
      expect(line.length).toBeLessThanOrEqual(48);
      for (const other of THREAD_AGENTS.filter(a => a !== id)) {
        expect(line).not.toContain(other);
        expect(noModelsLine(table)).not.toContain(other);
      }
    }
  });

  it("the pin is what was run on the row's own binary, and a row written from a CLI's docs claims none", () => {
    expect(harnessCatalog("claude")!.version).toBe("--help 2.1.280, 2026-09-23");
    expect(harnessCatalog("codex")!.version).toBe("app-server 0.153.0, 2026-09-07");
    expect(catalogSourceLine(harnessCatalog("codex")!, THIS_COMPUTER)).toBe("codex table, app-server 0.153.0, 2026-09-07");
    for (const id of ["gemini", "opencode", "pi", "hermes"]) {
      expect(harnessCatalog(id)!.version, id).toBeNull();
      expect(catalogSourceLine(harnessCatalog(id)!, THIS_COMPUTER)).toBe(`${id} table`);
    }
  });

  it("the claude row is the pinned binary's own handshake, so a bump of the pin fails here until a recording and the row move with it", () => {
    const recording = new URL(`../../adapter-claude/test/fixtures/catalog-probe-${CLAUDE_CODE.version}.txt`, import.meta.url);
    if (!existsSync(recording)) throw new Error(`no recorded handshake for ${CLAUDE_CODE.version}; record one with the probe command`);
    const probe = parseCatalogProbe(readFileSync(recording, "utf8"))!;
    expect(probe.version).toBe(CLAUDE_CODE.version);
    const row = harnessCatalog("claude")!;
    expect(row.version).toContain(` ${CLAUDE_CODE.version}, `);
    const heard = catalogFromProbe(row, probe);
    const models = (c: HarnessCatalog) => c.models.map(m => ({ value: m.value, isDefault: m.isDefault === true, efforts: m.efforts, contextWindows: m.contextWindows }));
    expect(models(row)).toEqual(models(heard));
    expect(row.efforts.map(o => o.value)).toEqual(heard.efforts.map(o => o.value));
    expect(new Set(row.permissionModes.map(o => o.value))).toEqual(new Set(heard.permissionModes.map(o => o.value)));
    expect(row.models.map(m => m.value)).toContain(row.smallModel);
  });

  describe("the claude rows against the pinned binary's own model catalog", () => {
    // One entry per current and legacy id off the binary's baked-in model table: its name, its context and its capabilities.
    const recording = new URL(`../../adapter-claude/test/fixtures/model-catalog-${CLAUDE_CODE.version}.json`, import.meta.url);
    type Entry = { id: string; display_name: string; context: { window: number; supports_1m_beta?: boolean; supports_1m_suffix?: boolean }; capabilities: string[]; default_effort?: string };
    const entries = (): Entry[] => {
      if (!existsSync(recording)) throw new Error(`no recorded model catalog for ${CLAUDE_CODE.version}; record the current and legacy ids' entries off the binary`);
      return JSON.parse(readFileSync(recording, "utf8")) as Entry[];
    };
    // The table keys a model by its family id; the row names the dated id the binary sends for it, as Haiku 4.5's is.
    const entryOf = (value: string): Entry | undefined => entries().find(e => e.id === value || e.id === value.replace(/-\d{8}$/, ""));
    const levels = (caps: string[]): string[] => [...(caps.includes("effort") ? ["low", "medium", "high"] : []), ...(caps.includes("xhigh_effort") ? ["xhigh"] : []), ...(caps.includes("max_effort") ? ["max"] : [])];

    it("each current model starts at the effort the table gives it, but Opus 5.5, which starts at the high the CLI documents", () => {
      // A start that names no effort is sent the marked one, so the mark is what a thread runs at. With no --effort the
      // binary would take an org default, then a remote flag, then the remote model config, then this table, which
      // gives Opus 5.5 medium; wsp keeps the documented high (code.claude.com/docs/en/model-config) for the model every
      // thread opens on rather than follow a baked value the account's remote config may already override.
      const row = harnessCatalog("claude")!;
      const startsAt = (value: string): string | undefined => effortsFor(row, modelOf(row, value)).find(o => o.isDefault)?.value;
      const differs = row.models.filter(m => startsAt(m.value) !== (entryOf(m.value)!.default_effort ?? startsAt(m.value)));
      expect(differs.map(m => [m.value, startsAt(m.value), entryOf(m.value)!.default_effort])).toEqual([["claude-opus-5-5", "high", "medium"]]);
      expect(row.models.map(m => m.efforts)).toEqual(row.models.map(m => levels(entryOf(m.value)!.capabilities)));
    });

    it("Haiku 4.5 takes no window though the table takes its 1M suffix: its window there is 200k with no 1M beta, and the handshake offers no 1M Haiku", () => {
      const haiku = entryOf("claude-haiku-4-5-20251001")!;
      expect(haiku.context).toEqual({ window: 200_000, supports_1m_suffix: true });
      expect(harnessCatalog("claude")!.models.find(m => m.value === "claude-haiku-4-5-20251001")?.contextWindows).toEqual([]);
    });

    it("the legacy rows are the table's, so a bump of the pin fails here until a recording and the rows move with it", () => {
      const current = new Set(harnessCatalog("claude")!.models.map(m => entryOf(m.value)?.id));
      expect(harnessCatalog("claude")!.legacyModels).toEqual(
        entries()
          .filter(e => !current.has(e.id))
          .map(e => ({
            value: e.id,
            label: e.display_name,
            efforts: levels(e.capabilities),
            ...(e.default_effort !== undefined ? { defaultEffort: e.default_effort } : {}),
            contextWindows: e.context.supports_1m_suffix === true ? ["200k", "1m"] : [],
          })),
      );
    });
  });

  it("Codex offers the models and reasoning efforts its app-server reports, and no context window", () => {
    const codex = harnessCatalog("codex")!;
    expect(codex.models.map(o => o.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(codex.legacyModels?.map(o => o.value)).toEqual(["gpt-5.5", "gpt-5.2"]);
    expect(codex.models.find(o => o.isDefault)?.value).toBe("gpt-5.6-sol");
    expect(everyModel(codex).map(o => o.efforts)).toEqual([
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "max"],
      ["low", "medium", "high", "xhigh"],
      ["low", "medium", "high", "xhigh"],
    ]);
    // The app-server reports a default effort per model, not one for the binary: Sol runs low, the other four medium.
    expect(everyModel(codex).map(o => o.defaultEffort)).toEqual(["low", "medium", "medium", "medium", "medium"]);
    // The title question still runs on the cheapest, which now sits under the fold.
    expect(smallestModel(codex)).toBe("gpt-5.2");
    expect(codex.efforts.map(o => o.value)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    // The effort the app-server reports for the default model, so the tab shows a default with no probe at all.
    expect(codex.efforts.find(o => o.isDefault)?.value).toBe("low");
    expect(codex.contextWindows).toEqual([]);
    expect(codex.permissionModes.map(o => o.value)).toEqual(["read-only", "workspace-write", "danger-full-access"]);
  });

  it("Claude Code offers the models, effort levels, context windows and permission modes its CLI takes", () => {
    const claude = harnessCatalog("claude")!;
    expect(claude.models.map(o => o.value)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    expect(claude.models.find(o => o.isDefault)?.value).toBe("claude-opus-5-5");
    expect(claude.models.map(o => o.contextWindows)).toEqual([["200k", "1m"], ["200k", "1m"], [], []]);
    // Haiku answers no effort list, so it takes no --effort.
    expect(claude.models.map(o => o.efforts?.length)).toEqual([5, 5, 5, 0]);
    // The older models the binary still runs as named; Opus 4.0 and 4.1 it runs as the latest Opus, Sonnet 4.0 is retired.
    expect(claude.legacyModels?.map(o => o.value)).toEqual(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-fable-5", "claude-sonnet-4-6", "claude-sonnet-4-5"]);
    expect(claude.efforts.map(o => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The handshake names no default effort; the CLI documents high on every model that takes one.
    expect(claude.efforts.find(o => o.isDefault)?.value).toBe("high");
    expect(claude.contextWindows).toEqual([{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }]);
    expect(claude.permissionModes.map(o => o.value)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "manual", "dontAsk"]);
    expect(claude.permissionModes.every(o => o.description !== undefined)).toBe(true);
  });

  it("a CLI without a flag, or with open values, leaves that list empty", () => {
    expect(harnessCatalog("gemini")!.efforts).toEqual([]);
    expect(harnessCatalog("pi")!.permissionModes).toEqual([]);
    expect(harnessCatalog("opencode")!.efforts).toEqual([]);
    expect(harnessCatalog("aider")).toBeUndefined();
  });
});

describe("the default effort of a pick", () => {
  const codex = harnessCatalog("codex")!;
  const model = (value: string) => modelOf(codex, value);
  const shown = (value: string | null) => markedDefault(effortsFor(codex, value === null ? null : model(value)))?.value;

  it("is the picked model's own, so the picker marks what that model will run rather than what the binary's default model runs", () => {
    expect(shown("gpt-5.5")).toBe("medium");
    expect(shown("gpt-5.6-terra")).toBe("medium");
    expect(shown("gpt-5.6-sol")).toBe("low");
    // One mark on the list, not the model's beside the catalog's.
    expect(effortsFor(codex, model("gpt-5.5")).filter(o => o.isDefault).map(o => o.value)).toEqual(["medium"]);
  });

  it("is the catalog's mark for a model that names none, and for no model at all", () => {
    const claude = harnessCatalog("claude")!;
    expect(markedDefault(effortsFor(claude, markedDefault(claude.models) ?? null))?.value).toBe("high");
    expect(markedDefault(effortsFor(claude, null))?.value).toBe("high");
    // Every model this list carries that takes an effort runs at high, and Haiku, which takes none, is given none.
    expect(claude.models.map(m => markedDefault(effortsFor(claude, m))?.value)).toEqual(["high", "high", "high", undefined]);
    expect(modelOf(claude, "claude-fable-5-1")).toMatchObject({ label: "Fable 5.1", contextWindows: ["200k", "1m"] });
    // A model the binary routes to another provider names no efforts and no default of its own.
    expect(markedDefault(effortsFor(codex, { value: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5" }))?.value).toBe("low");
    expect(shown(null)).toBe("low");
  });

  it("marks nothing when the model names a default its own list does not carry", () => {
    const odd = { ...codex, models: [{ value: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "high"], defaultEffort: "medium" }] };
    expect(effortsFor(odd, odd.models[0]!).some(o => o.isDefault)).toBe(false);
  });
});

describe("what an access mode says it does", () => {
  // This menu is where a person decides what an agent may do on their computer, so every sentence is about that and
  // not about the binary behind it: no word from an agent's own documentation, no name of an agent, one sentence each.
  const INTERNALS = [/classifier/i, /\bCLIs?\b/, /print mode/i, /\bmachines?\b/i];
  const AGENT_NAMES = HARNESS_CATALOGS.flatMap(c => [new RegExp(`\\b${c.harness}\\b`, "i"), new RegExp(`\\b${c.label}\\b`, "i")]);

  it("says what the agent may do, naming no agent and nothing inside one", () => {
    const modes = HARNESS_CATALOGS.flatMap(c => c.permissionModes.map(o => [`${c.harness} ${o.value}`, o.description] as const));
    expect(modes.length).toBeGreaterThan(15);
    for (const [where, description] of modes) {
      expect(description, where).toBeDefined();
      for (const word of [...INTERNALS, ...AGENT_NAMES]) expect(description!, `${where} against ${word.source}`).not.toMatch(word);
      // One sentence: the semicolon joins two halves of the same one, a full stop would start another.
      expect(description!, where).not.toContain(".");
    }
  });

  it("the two a person could not read now read as a person would say them", () => {
    const claude = harnessCatalog("claude")!;
    const mode = (value: string) => claude.permissionModes.find(o => o.value === value)?.description;
    expect(mode("auto")).toBe("The agent decides which actions to ask about; where the account has no such mode it asks as Default does");
    expect(mode("manual")).toBe("Asks before every action");
  });
});

describe("the access a thread starts at, per kind of workspace", () => {
  it("every harness with an access mode names both the mode that asks and the mode that asks nothing, and marks neither", () => {
    for (const catalog of HARNESS_CATALOGS) {
      if (catalog.permissionModes.length === 0) {
        expect(catalog.keptMode).toBeUndefined();
        continue;
      }
      expect(catalog.keptMode).toBeDefined();
      expect(catalog.permissionModes.map(o => o.value)).toContain(catalog.keptMode);
      // Each row names its own skip-everything mode, so nothing outside the table keeps a list of them.
      expect(catalog.bypassMode).toBeDefined();
      expect(catalog.permissionModes.map(o => o.value)).toContain(catalog.bypassMode);
      expect(catalog.bypassMode).not.toBe(catalog.keptMode);
      // The mark has one home, and it is not here: which of the two a start runs at belongs to the workspace's
      // kind, and a mark left on a row would be a second answer for anyone reading the table without a workspace.
      expect(markedDefault(catalog.permissionModes)).toBeUndefined();
    }
  });

  it("claude asks the person in its default mode; codex exec cannot ask, so its narrowest working sandbox stands", () => {
    expect(harnessCatalog("claude")!.keptMode).toBe("default");
    expect(harnessCatalog("codex")!.keptMode).toBe("workspace-write");
  });

  it("on this computer a start with no access word runs every action without asking, on every harness that takes a mode", () => {
    // Every row in the table, so a harness added to it is held to the ruling without anyone coming back here.
    for (const table of HARNESS_CATALOGS) {
      if (table.permissionModes.length === 0) continue;
      const mac = workspaceAccess(table, "local");
      expect(markedDefault(mac.permissionModes)?.value, table.harness).toBe(table.bypassMode);
      expect(mac.permissionModes.filter(o => o.isDefault), table.harness).toHaveLength(1);
      // A fork wsp made runs the same, and nothing of the person's is named on the pick there.
      expect(markedDefault(workspaceAccess(table, "cloud").permissionModes)?.value, table.harness).toBe(table.bypassMode);
    }
    // The words those rows spell, so the loop above cannot pass on a table that lost them.
    expect(HARNESS_CATALOGS.filter(c => c.permissionModes.length > 0).map(c => [c.harness, c.bypassMode])).toEqual([
      ["claude", "bypassPermissions"],
      ["codex", "danger-full-access"],
      ["gemini", "yolo"],
      ["opencode", "auto"],
      ["hermes", "yolo"],
    ]);
  });

  it("on a computer somebody owns the mark sits on the mode that asks, and that computer is named on the mode that does not", () => {
    const kept = workspaceAccess(harnessCatalog("claude")!, "ssh");
    expect(markedDefault(kept.permissionModes)?.value).toBe("default");
    expect(kept.permissionModes.filter(o => o.isDefault)).toHaveLength(1);
    // The machine named is that kind's own word for its machine, never this computer's: the pick hands over the box.
    expect(kept.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe(`Bypass on ${OVER_SSH}`);
    // The CLI's own word stays as the short form the picker's button wears; no other row has one.
    expect(kept.permissionModes.find(o => o.value === "bypassPermissions")?.short).toBe("Bypass");
    expect(kept.permissionModes.filter(o => o.short !== undefined).map(o => o.value)).toEqual(["bypassPermissions"]);
    // Same modes, same order, same descriptions: every other mode is one pick away, where it was.
    expect(kept.permissionModes.map(o => o.value)).toEqual(harnessCatalog("claude")!.permissionModes.map(o => o.value));
    expect(kept.permissionModes.map(o => o.description)).toEqual(harnessCatalog("claude")!.permissionModes.map(o => o.description));
    expect(HarnessCatalog.parse(kept)).toEqual(kept);
    const codex = workspaceAccess(harnessCatalog("codex")!, "ssh");
    expect(markedDefault(codex.permissionModes)?.value).toBe("workspace-write");
    expect(codex.permissionModes.find(o => o.value === "danger-full-access")?.label).toBe(`Full access on ${OVER_SSH}`);
    expect(codex.permissionModes.find(o => o.value === "danger-full-access")?.short).toBe("Full access");
  });

  it("this computer's own word is on its own pick, and a machine wsp forked names none", () => {
    const mac = workspaceAccess(harnessCatalog("claude")!, "local");
    expect(mac.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe(`Bypass on ${THIS_COMPUTER}`);
    const fork = workspaceAccess(harnessCatalog("claude")!, "cloud");
    expect(fork.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe("Bypass");
    expect(fork.permissionModes.filter(o => o.short !== undefined)).toEqual([]);
  });

  it("a catalog with no access mode of its own comes back untouched, so nothing invents one for it", () => {
    const pi = harnessCatalog("pi")!;
    expect(workspaceAccess(pi, "local")).toBe(pi);
    expect(workspaceAccess(pi, "cloud")).toBe(pi);
  });
});

describe("startPicks", () => {
  /** The lists as a workspace answers with them, which is the only shape a start is ever checked against: the
   * mark is placed against that workspace's kind, and a fork wsp made runs every action without asking. */
  const claude = workspaceAccess(harnessCatalog("claude")!, "cloud");
  const MODELS = "Opus 5.5 (claude-opus-5-5), Fable 5.1 (claude-fable-5-1), Sonnet 5 (claude-sonnet-5), Haiku 4.5 (claude-haiku-4-5-20251001)";
  /** A catalog whose default model takes two of the five efforts and whose other model takes none. */
  const narrowed = { ...claude, models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, efforts: ["high", "max"] }, { value: "claude-haiku-4-5", label: "Haiku", efforts: [] }] };

  it("a start that opens a thread without a pick runs every default the composer shows, the access included; a resume keeps the thread's own", () => {
    // Claude names no default effort per model, so the catalog's own mark is what the pick runs at. The access is
    // filled in like the other two: an unnamed one used to reach the adapter as nothing, which it reads as bypass.
    // On this computer the same start runs bypass too, and the only kinds that ask are the computers a person owns.
    expect(startPicks(claude, {}, true)).toEqual({ model: "claude-opus-5-5", effort: "high", permissionMode: "bypassPermissions" });
    expect(startPicks(claude, {}, false)).toEqual({});
    expect(startPicks(claude, { model: "claude-sonnet-5", effort: "low", permissionMode: "plan" }, true)).toEqual({ model: "claude-sonnet-5", effort: "low", permissionMode: "plan" });
    expect(startPicks(claude, { effort: "max" }, false)).toEqual({ effort: "max" });
    const noDefault = { ...claude, models: claude.models.map(({ isDefault: _d, ...m }) => m) };
    expect(startPicks(noDefault, {}, true)).toEqual({ effort: "high", permissionMode: "bypassPermissions" });
    // On a computer the person owns the same start runs the mode its harness asks in, and nothing else changes.
    expect(startPicks(workspaceAccess(harnessCatalog("claude")!, "ssh"), {}, true)).toEqual({ model: "claude-opus-5-5", effort: "high", permissionMode: "default" });
  });

  it("listedPick keeps a remembered pick this list carries and drops one it does not, which is not a refusal", () => {
    // The one rule every reader of a remembered pick uses: the composer's pickers, its start options and the
    // runtime's own read of the record. A pick belongs to a harness and is kept per workspace, so the reader in
    // front of it may be another harness's list.
    expect(listedPick(claude.permissionModes, "plan")).toBe("plan");
    expect(listedPick(claude.permissionModes, "read-only")).toBeUndefined();
    expect(listedPick(claude.permissionModes, undefined)).toBeUndefined();
    expect(listedPick(harnessCatalog("pi")!.permissionModes, "plan")).toBeUndefined();
    // Dropped, the start runs that list's own default, and never the value a caller named: that one still refuses.
    expect(startPicks(claude, { permissionMode: listedPick(claude.permissionModes, "read-only") }, true).permissionMode).toBe("bypassPermissions");
    expect(() => startPicks(claude, { permissionMode: "read-only" }, true)).toThrow(/not one claude takes/);
  });

  it("refuses a value the catalog does not list, naming the list in the composer's words", () => {
    expect(() => startPicks(claude, { model: "claude-opus-4-1" }, true)).toThrow(`model "claude-opus-4-1" is not one claude takes; one of: ${MODELS}`);
    expect(() => startPicks(claude, { effort: "ultra" }, false)).toThrow('effort "ultra" is not one claude takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max)');
    expect(() => startPicks(claude, { permissionMode: "yolo" }, true)).toThrow(
      'access mode "yolo" is not one claude takes; one of: Default (default), Accept edits (acceptEdits), Plan (plan), Bypass (bypassPermissions), Auto (auto), Manual (manual), Don\'t ask (dontAsk)',
    );
  });

  it("a model that takes no effort at all is given none, and one that takes some runs the default its own list carries", () => {
    expect(startPicks(narrowed, { model: "claude-haiku-4-5" }, true)).toEqual({ model: "claude-haiku-4-5", permissionMode: "bypassPermissions" });
    expect(startPicks(narrowed, {}, true)).toEqual({ model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions" });
    // A model whose own list drops the catalog's marked effort is left to the CLI, since nothing in its list is marked.
    const off = { ...claude, models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, efforts: ["low", "max"] }] };
    expect(startPicks(off, {}, true)).toEqual({ model: "claude-opus-5", permissionMode: "bypassPermissions" });
  });

  it("an effort is checked against the model's own list where the model has one, the chosen or the default model", () => {
    expect(startPicks(narrowed, { effort: "max" }, true)).toEqual({ model: "claude-opus-5", effort: "max", permissionMode: "bypassPermissions" });
    expect(() => startPicks(narrowed, { effort: "low" }, true)).toThrow('effort "low" is not one Opus 5 takes; one of: High (high), Max (max)');
    expect(() => startPicks(narrowed, { model: "claude-haiku-4-5", effort: "low" }, true)).toThrow("Haiku takes no effort");
    expect(startPicks(narrowed, { effort: "low" }, false)).toEqual({ effort: "low" });
  });

  it("a list the CLI leaves empty takes any value, since the values are open or the flag does not exist", () => {
    const gemini = harnessCatalog("gemini")!;
    expect(startPicks(gemini, { model: "gemini-3-pro" }, true)).toEqual({ model: "gemini-3-pro" });
    expect(startPicks(gemini, { effort: "anything" }, true)).toEqual({ effort: "anything" });
    const pi = harnessCatalog("pi")!;
    expect(startPicks(pi, { permissionMode: "anything" }, true)).toEqual({ permissionMode: "anything" });
  });

  it("a start on the Codex table runs its default model and refuses a model or effort that table does not carry", () => {
    const codex = workspaceAccess(harnessCatalog("codex")!, "cloud");
    expect(startPicks(codex, {}, true)).toEqual({ model: "gpt-5.6-sol", effort: "low", permissionMode: "danger-full-access" });
    expect(markedDefault(effortsFor(codex, markedDefault(codex.models) ?? null))?.value).toBe("low");
    expect(startPicks(codex, { model: "gpt-5.5", effort: "high", permissionMode: "read-only" }, true)).toEqual({ model: "gpt-5.5", effort: "high", permissionMode: "read-only" });
    // The model's own default, not the catalog's low, which is the effort the binary reports for gpt-5.6-sol.
    expect(startPicks(codex, { model: "gpt-5.5" }, true)).toEqual({ model: "gpt-5.5", effort: "medium", permissionMode: "danger-full-access" });
    expect(startPicks(codex, { model: "gpt-5.5" }, false)).toEqual({ model: "gpt-5.5" });
    expect(() => startPicks(codex, { model: "gpt-4" }, true)).toThrow('model "gpt-4" is not one codex takes');
    expect(() => startPicks(codex, { model: "gpt-5.5", effort: "ultra" }, true)).toThrow('effort "ultra" is not one GPT-5.5 takes');
  });

  it("a start on a legacy model runs that model at the levels the binary lists for it, and a refusal names the legacy ones apart", () => {
    const claude = workspaceAccess(harnessCatalog("claude")!, "cloud");
    expect(startPicks(claude, { model: "claude-opus-5", effort: "high" }, true)).toEqual({ model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions" });
    // Its own default, where the binary lists one; the catalog's high where it lists none.
    expect(startPicks(claude, { model: "claude-opus-4-7" }, true)).toMatchObject({ effort: "xhigh" });
    expect(startPicks(claude, { model: "claude-opus-4-6" }, true)).toMatchObject({ effort: "high" });
    expect(() => startPicks(claude, { model: "claude-opus-4-6", effort: "xhigh" }, true)).toThrow('effort "xhigh" is not one Opus 4.6 takes');
    expect(startPicks(claude, { model: "claude-sonnet-4-5" }, true)).toEqual({ model: "claude-sonnet-4-5", permissionMode: "bypassPermissions" });
    expect(() => startPicks(claude, { model: "claude-sonnet-4-5", effort: "high" }, true)).toThrow("Sonnet 4.5 takes no effort");
    expect(() => startPicks(claude, { model: "claude-opus-4-1" }, true)).toThrow(
      'model "claude-opus-4-1" is not one claude takes; one of: Opus 5.5 (claude-opus-5-5), Fable 5.1 (claude-fable-5-1), Sonnet 5 (claude-sonnet-5), Haiku 4.5 (claude-haiku-4-5-20251001); legacy: Opus 5 (claude-opus-5), Opus 4.8 (claude-opus-4-8),',
    );
  });

  it("a harness without a catalog takes any value and fills no default; only the three picks come out, whatever else the request carries", () => {
    const request = { prompt: "go", harness: "aider", model: "gpt-9", effort: "high", requestId: "r1", startedBy: "cli", cwd: "/w" };
    expect(startPicks(undefined, request, true)).toEqual({ model: "gpt-9", effort: "high" });
    expect(startPicks(claude, { ...request, model: "claude-sonnet-5" }, false)).toEqual({ model: "claude-sonnet-5", effort: "high" });
  });
});

describe("catalogFromProbe", () => {
  const probe: HarnessCatalogProbe = {
    version: "2.1.257",
    models: [
      { slug: "claude-opus-5-5", label: "Opus", description: "Opus 5.5 with 1M context", efforts: ["low", "high"], contextWindows: ["200k", "1m"], isDefault: true },
      { slug: "claude-haiku-4-5-20251001", label: "Haiku", efforts: [], contextWindows: [], isDefault: false },
      { slug: "claude-next-6", label: "Next", efforts: ["low", "turbo"], contextWindows: [], isDefault: false },
    ],
    efforts: ["low", "high", "turbo"],
    permissionModes: ["default", "plan", "yolo"],
  };

  it("takes the binary's values and defaults, borrows the table's labels and descriptions, and says the binary answered", () => {
    const catalog = catalogFromProbe(harnessCatalog("claude")!, probe);
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog).toMatchObject({ harness: "claude", label: "Claude Code", source: "harness", version: "2.1.257" });
    expect(catalog.models).toEqual([
      { value: "claude-opus-5-5", label: "Opus 5.5", description: "Opus 5.5 with 1M context", isDefault: true, efforts: ["low", "high"], contextWindows: ["200k", "1m"] },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [], contextWindows: [] },
      { value: "claude-next-6", label: "Next", efforts: ["low", "turbo"], contextWindows: [] },
    ]);
    expect(catalog.efforts).toEqual([{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }, { value: "turbo", label: "Turbo" }]);
    // A binary that no longer lists the table's default effort leaves none marked.
    expect(catalogFromProbe(harnessCatalog("claude")!, { ...probe, efforts: ["low", "turbo"] }).efforts.some(o => o.isDefault)).toBe(false);
    expect(catalog.contextWindows).toEqual(harnessCatalog("claude")!.contextWindows);
    expect(catalog.permissionModes.map(o => o.value)).toEqual(["default", "plan", "yolo"]);
    expect(catalog.permissionModes[1]?.description).toBe("Reads and plans only; changes nothing");
    // A mode the table has no words for still shows, named as the CLI spells it.
    expect(catalog.permissionModes[2]).toEqual({ value: "yolo", label: "yolo" });
    // The table's bypass default is not among the binary's modes here, so nothing is default.
    expect(catalog.permissionModes.some(o => o.isDefault)).toBe(false);
  });

  it("keeps the table's legacy models on a binary that lists none of them, since it still runs each by name", () => {
    const catalog = catalogFromProbe(harnessCatalog("claude")!, probe);
    expect(catalog.legacyModels).toEqual(harnessCatalog("claude")!.legacyModels);
    // One it names is among its current models, and leaves the fold.
    const current = catalogFromProbe(harnessCatalog("claude")!, { ...probe, models: [...probe.models, { slug: "claude-opus-4-8", label: "Opus", efforts: ["low"], contextWindows: [], isDefault: false }] });
    expect(current.models.map(m => m.value)).toContain("claude-opus-4-8");
    expect(current.legacyModels?.map(m => m.value)).toEqual(["claude-opus-5", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-fable-5", "claude-sonnet-4-6", "claude-sonnet-4-5"]);
    expect(startPicks(catalog, { model: "claude-fable-5" }, false)).toEqual({ model: "claude-fable-5" });
  });

  it("keeps a legacy model under the fold in the binary's own words where its list carries it, and drops one it leaves out", () => {
    const codexProbe: HarnessCatalogProbe = {
      version: "0.153.0",
      models: [
        { slug: "gpt-5.6-sol", label: "gpt-5.6-sol", efforts: ["low", "high"], defaultEffort: "low", contextWindows: [], isDefault: true },
        { slug: "gpt-5.5", label: "gpt-5.5", efforts: ["low", "medium"], defaultEffort: "low", contextWindows: [], isDefault: false },
      ],
      efforts: ["low", "medium", "high"],
      permissionModes: ["read-only"],
    };
    const catalog = catalogFromProbe(harnessCatalog("codex")!, codexProbe);
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.models.map(m => m.value)).toEqual(["gpt-5.6-sol"]);
    expect(catalog.legacyModels).toEqual([{ value: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium"], defaultEffort: "low", contextWindows: [] }]);
    expect(startPicks(catalog, { model: "gpt-5.5" }, true)).toEqual({ model: "gpt-5.5", effort: "low" });
    expect(() => startPicks(catalog, { model: "gpt-5.2" }, true)).toThrow('model "gpt-5.2" is not one codex takes');
    // Its title question then runs on whatever the CLI runs without a model.
    expect(smallestModel(catalog)).toBeUndefined();
    // A binary whose own default is an older model keeps it in front, where the default mark can be seen.
    const older = catalogFromProbe(harnessCatalog("codex")!, { ...codexProbe, models: codexProbe.models.map(m => ({ ...m, isDefault: m.slug === "gpt-5.5" })) });
    expect(older.models.map(m => m.value)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    expect(older.legacyModels).toEqual([]);
  });

  it("a probe without a version says so instead of pretending to the table's pin", () => {
    expect(catalogFromProbe(harnessCatalog("claude")!, { ...probe, version: null }).version).toBeNull();
    expect(catalogSourceLine(catalogFromProbe(harnessCatalog("claude")!, { ...probe, version: null }), THIS_COMPUTER)).toBe("Claude Code on this computer");
    expect(catalogSourceLine(catalogFromProbe(harnessCatalog("claude")!, probe), "hetzner")).toBe("Claude Code 2.1.257 on hetzner");
  });

  it("a model whose efforts the binary did not name keeps none of its own, so every effort the catalog lists stays open to it", () => {
    const routed = { ...probe, models: [{ slug: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", contextWindows: [], isDefault: true }, ...probe.models.map(m => ({ ...m, isDefault: false }))] };
    const catalog = catalogFromProbe(harnessCatalog("codex")!, routed);
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.models[0]).toEqual({ value: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", isDefault: true, contextWindows: [] });
    expect("efforts" in catalog.models[0]!).toBe(false);
    // Absent, not empty: empty would mean the model takes no effort at all and refuse every one.
    expect(effortsFor(catalog, catalog.models[0]!).map(o => o.value)).toEqual(["low", "high", "turbo"]);
    expect(startPicks(catalog, { effort: "turbo" }, true)).toEqual({ model: "anthropic/claude-sonnet-4.5", effort: "turbo" });
    expect(() => startPicks(catalog, { effort: "off" }, true)).toThrow('effort "off" is not one codex takes');
    // A model that named an empty list still takes none.
    expect(effortsFor(catalog, catalog.models.find(m => m.value === "claude-haiku-4-5-20251001")!)).toEqual([]);
  });

  it("carries each model's own default effort, so a pick runs what the binary reports for that model", () => {
    const perModel = { ...probe, models: probe.models.map(m => (m.slug === "claude-next-6" ? { ...m, defaultEffort: "turbo" } : m)) };
    const catalog = catalogFromProbe(harnessCatalog("claude")!, perModel);
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.models.map(m => m.defaultEffort)).toEqual([undefined, undefined, "turbo"]);
    expect(markedDefault(effortsFor(catalog, catalog.models[2]!))?.value).toBe("turbo");
    expect(startPicks(catalog, { model: "claude-next-6" }, true)).toEqual({ model: "claude-next-6", effort: "turbo" });
    // The models that named none keep the catalog's mark, which the binary reports for the model it would run.
    expect(markedDefault(effortsFor(catalog, catalog.models[0]!))?.value).toBe("high");
  });

  it("marks the effort the binary reports for the model it would run, and keeps the table's mark where it reports none", () => {
    const withDefault = { ...probe, models: probe.models.map(m => (m.isDefault ? { ...m, defaultEffort: "turbo" } : m)) };
    expect(catalogFromProbe(harnessCatalog("codex")!, withDefault).efforts.find(o => o.isDefault)?.value).toBe("turbo");
    // The table's own mark is dropped, not kept beside the binary's.
    expect(catalogFromProbe(harnessCatalog("codex")!, withDefault).efforts.filter(o => o.isDefault)).toHaveLength(1);
    expect(catalogFromProbe(harnessCatalog("codex")!, probe).efforts.find(o => o.isDefault)?.value).toBe("low");
    // An effort the binary names as its default that its own list does not carry marks nothing.
    const odd = { ...probe, models: probe.models.map(m => (m.isDefault ? { ...m, defaultEffort: "nope" } : m)) };
    expect(catalogFromProbe(harnessCatalog("codex")!, odd).efforts.some(o => o.isDefault)).toBe(false);
  });

  it("keeps the harness-level flags the runtime set on the table: the default harness stays marked when its binary answered", () => {
    expect(catalogFromProbe({ ...harnessCatalog("claude")!, isDefault: true, steers: true }, probe)).toMatchObject({ isDefault: true, steers: true });
    expect(catalogFromProbe(harnessCatalog("claude")!, probe).isDefault).toBeUndefined();
  });
});
