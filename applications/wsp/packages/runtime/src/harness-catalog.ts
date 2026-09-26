// SPDX-License-Identifier: AGPL-3.0-only
// What each harness's CLI accepts at launch, as its own binary spells it, so
// the composer's pickers offer only values the CLI will take. This table is
// the fallback: an adapter that probes reads its lists from the binary on the
// workspace's machine when it answers (catalogFromProbe), and the table lends
// it the labels and descriptions the binary has no words for. Each row carries
// the pin it was read against, its own command, version and day, since a row
// that borrowed another agent's pin would tell the person the wrong thing
// about the list in front of them. Gemini CLI, OpenCode, Pi and Hermes have no
// adapter yet; their catalogs name the flags their CLIs document, so they
// carry no pin of our own reading and the pickers are right the day one lands.
// A list is empty where the CLI has no such flag or takes open values.
import { CLAUDE_SCREEN_COMMANDS } from "@wsp/adapter-claude";
import { CLAUDE_CODE } from "@wsp/catalog";
import { everyModel } from "@wsp/protocol";
import type { HarnessCatalog, HarnessCatalogProbe, HarnessModel, HarnessOption } from "@wsp/protocol";

/** What one row's table was read against: what was run on the row's own binary, the version it reported and the day it
 * was read. A row served from the table carries this as its version, and the footer names the agent beside it, so the
 * binary's own name is not repeated here. */
interface TablePin {
  /** What followed the binary, as it was typed: the flag or subcommand whose answer the lists below came from. */
  read: string;
  version: string;
  date: string;
}

const option = (value: string, label: string, description?: string): HarnessOption => ({
  value,
  label,
  ...(description !== undefined ? { description } : {}),
});

const capitalize = (value: string): string => (value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1));

/** Effort levels in the CLI's own order, with the one a turn that names none runs marked, where the CLI has one. */
const levels = (values: readonly string[], isDefault?: string): HarnessOption[] =>
  values.map(value => (value === isDefault ? { ...option(value, capitalize(value)), isDefault: true } : option(value, capitalize(value))));

const CLAUDE_CONTEXT_WINDOWS: HarnessOption[] = [option("200k", "200k"), { ...option("1m", "1M"), isDefault: true }];

// The handshake lists each model's levels and names no default; the CLI documents high on every model that takes one (code.claude.com/docs/en/model-config, Adjust effort level).
// The binary's baked-in table gives Opus 5.5 medium instead; harness-catalog.test.ts pins that difference and why high stays.
const CLAUDE_EFFORTS: HarnessOption[] = levels(["low", "medium", "high", "xhigh", "max"], "high");

// The table alone cannot say whether a harness steers, whether it keeps a person's name for a session, or whether it
// reads an image: only its adapter, on a machine, knows any of the three. A client reads a table row as no answer
// (keepsRename, readsImages), never as a no. mcpServers is not one of those: no binary decides it, so a row names it
// here and harness-catalog.test.ts pins every row to its adapter's own declaration.
const fromTable = (
  catalog: Omit<HarnessCatalog, "source" | "version" | "contextWindows" | "steers" | "renames" | "images"> & { contextWindows?: HarnessOption[]; pin?: TablePin },
): HarnessCatalog => {
  const { pin, ...rest } = catalog;
  return {
    source: "table",
    version: pin === undefined ? null : `${pin.read} ${pin.version}, ${pin.date}`,
    contextWindows: [],
    steers: false,
    renames: false,
    images: false,
    ...rest,
  };
};

export const HARNESS_CATALOGS: readonly HarnessCatalog[] = [
  fromTable({
    harness: "claude",
    label: "Claude Code",
    // The models below are the pinned binary's handshake; harness-catalog.test.ts holds them to its recording.
    pin: { read: "--help", version: CLAUDE_CODE.version, date: "2026-09-23" },
    // --mcp-config takes the servers as JSON on the launch (read off `claude --help` at 2.1.257, 2026-09-10).
    mcpServers: true,
    // Its control channel takes a mode change while a turn runs, and the prompt that turn is stopped on is answered
    // with it, so an access picked mid-turn lands on the turn in front of the person.
    movesAccess: true,
    screenCommands: [...CLAUDE_SCREEN_COMMANDS],
    // The cheapest of the four at $1/$5 per Mtok, as the CLI's own handshake prices them (read 2026-09-23).
    smallModel: "claude-haiku-4-5-20251001",
    models: [
      { ...option("claude-opus-5-5", "Opus 5.5"), isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], contextWindows: ["200k", "1m"] },
      { ...option("claude-fable-5-1", "Fable 5.1"), efforts: ["low", "medium", "high", "xhigh", "max"], contextWindows: ["200k", "1m"] },
      { ...option("claude-sonnet-5", "Sonnet 5"), efforts: ["low", "medium", "high", "xhigh", "max"], contextWindows: [] },
      { ...option("claude-haiku-4-5-20251001", "Haiku 4.5"), efforts: [], contextWindows: [] },
    ],
    // The pinned binary's own model catalog, which harness-catalog.test.ts holds these to: each is run as named, with
    // the levels, default and 1M suffix it lists. Opus 4.0 and 4.1 are run as the latest Opus and Sonnet 4.0 is retired.
    legacyModels: [
      { ...option("claude-opus-5", "Opus 5"), efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindows: ["200k", "1m"] },
      { ...option("claude-opus-4-8", "Opus 4.8"), efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindows: ["200k", "1m"] },
      { ...option("claude-opus-4-7", "Opus 4.7"), efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "xhigh", contextWindows: ["200k", "1m"] },
      { ...option("claude-opus-4-6", "Opus 4.6"), efforts: ["low", "medium", "high", "max"], contextWindows: ["200k", "1m"] },
      { ...option("claude-opus-4-5", "Opus 4.5"), efforts: [], contextWindows: ["200k", "1m"] },
      { ...option("claude-fable-5", "Fable 5"), efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindows: [] },
      { ...option("claude-sonnet-4-6", "Sonnet 4.6"), efforts: ["low", "medium", "high", "max"], contextWindows: ["200k", "1m"] },
      { ...option("claude-sonnet-4-5", "Sonnet 4.5"), efforts: [], contextWindows: ["200k", "1m"] },
    ],
    efforts: CLAUDE_EFFORTS,
    contextWindows: CLAUDE_CONTEXT_WINDOWS,
    // default is the mode this CLI raises its own prompts in: with --permission-prompt-tool they reach the host over
    // the control channel and the person answers them in the chat (measured on 2.1.263, 2026-09-08). No mode here
    // carries the default mark: which of the two below a thread starts at belongs to the workspace's kind, and
    // workspaceAccess places the mark against it.
    keptMode: "default",
    bypassMode: "bypassPermissions",
    permissionModes: [
      option("default", "Default", "Asks in the chat about each action that needs permission"),
      option("acceptEdits", "Accept edits", "Edits files without asking; asks about commands that need permission"),
      option("plan", "Plan", "Reads and plans only; changes nothing"),
      option("bypassPermissions", "Bypass", "Runs every action without asking"),
      option("auto", "Auto", "The agent decides which actions to ask about; where the account has no such mode it asks as Default does"),
      // A turn launched in manual comes back naming default as the mode it ran in, so its own report is no proof of it.
      option("manual", "Manual", "Asks before every action"),
      option("dontAsk", "Don't ask", "Refuses any action that needs permission, without asking"),
    ],
  }),
  fromTable({
    harness: "codex",
    label: "Codex",
    // The models and their efforts as the app-server's model/list answered them, each with the effort it reports for
    // that model; the sandbox modes are the choices `codex --help` prints for -s. No codex model runs at two context
    // windows, so it takes no window at all.
    pin: { read: "app-server", version: "0.153.0", date: "2026-09-07" },
    // Servers ride the launch as `-c mcp_servers.<name>...` overrides (checked with `codex mcp get` on 0.155.1).
    mcpServers: true,
    // The oldest generation model/list still offers, and the cheapest of them.
    smallModel: "gpt-5.2",
    models: [
      { ...option("gpt-5.6-sol", "GPT-5.6-Sol"), isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
      { ...option("gpt-5.6-terra", "GPT-5.6-Terra"), efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
      { ...option("gpt-5.6-luna", "GPT-5.6-Luna"), efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
    ],
    // A generation behind 5.6; model/list names every model the binary runs, these two among them.
    legacyListed: true,
    legacyModels: [
      { ...option("gpt-5.5", "GPT-5.5"), efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { ...option("gpt-5.2", "GPT-5.2"), efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    ],
    efforts: levels(["low", "medium", "high", "xhigh", "max", "ultra"], "low"),
    // `codex exec` runs non-interactively and its JSON stream carries no approval request, so this CLI cannot ask
    // anyone anything: the narrowest sandbox a turn can still work in is the whole answer for a kept machine.
    keptMode: "workspace-write",
    bypassMode: "danger-full-access",
    permissionModes: [
      option("read-only", "Read only", "Reads only; edits no files and runs no command that writes"),
      option("workspace-write", "Workspace write", "Edits files and runs commands inside the working folder"),
      option("danger-full-access", "Full access", "Runs every action without asking, with no folder off limits"),
    ],
  }),
  fromTable({
    harness: "gemini",
    label: "Gemini CLI",
    models: [],
    efforts: [],
    keptMode: "default",
    bypassMode: "yolo",
    permissionModes: [
      option("default", "Default", "Asks before every action"),
      option("auto_edit", "Auto edit", "Edits files without asking"),
      option("yolo", "Yolo", "Runs every action without asking"),
    ],
  }),
  fromTable({
    harness: "opencode",
    label: "OpenCode",
    models: [],
    efforts: [],
    keptMode: "default",
    bypassMode: "auto",
    permissionModes: [option("default", "Default", "Asks as its own settings say"), option("auto", "Auto", "Runs every action its own settings do not deny")],
  }),
  fromTable({
    harness: "pi",
    label: "Pi",
    models: [],
    efforts: levels(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    permissionModes: [],
  }),
  fromTable({
    harness: "hermes",
    label: "Hermes Agent",
    models: [],
    efforts: levels(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    keptMode: "default",
    bypassMode: "yolo",
    permissionModes: [option("default", "Default", "Asks before a command that could do damage"), option("yolo", "Yolo", "Runs a command that could do damage without asking")],
  }),
];

export function harnessCatalog(harness: string): HarnessCatalog | undefined {
  return HARNESS_CATALOGS.find(c => c.harness === harness);
}

/** The model a thread's title question runs on: the harness row's own smallest, where the catalog in front of us
 * still lists it. Nothing where the harness names none and where the binary no longer offers the one it named, and
 * the question then runs on whatever that CLI runs without a model. */
export function smallestModel(catalog: HarnessCatalog | undefined): string | undefined {
  if (catalog?.smallModel === undefined) return undefined;
  return everyModel(catalog).some(m => m.value === catalog.smallModel) ? catalog.smallModel : undefined;
}

/** The binary's lists in the wire shape: its values and defaults win, the table lends labels and descriptions it knows.
 * The table's legacy models are read against the answer as the row's legacyListed says.
 * A model whose efforts the binary did not name keeps none of its own, so every effort the catalog lists stays open to
 * it; each model carries the effort the binary reports for it, and the catalog's own mark is the one it reports for
 * the model it would run, else the table's mark, which effortsFor reads for a model that names none. */
export function catalogFromProbe(table: HarnessCatalog, probe: HarnessCatalogProbe): HarnessCatalog {
  const known = (list: readonly HarnessOption[], value: string): HarnessOption | undefined => list.find(o => o.value === value);
  const heard: HarnessModel[] = probe.models.map(m => ({
    value: m.slug,
    label: known(everyModel(table), m.slug)?.label ?? m.label,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...(m.isDefault ? { isDefault: true } : {}),
    ...(m.efforts !== undefined ? { efforts: [...m.efforts] } : {}),
    ...(m.defaultEffort !== undefined ? { defaultEffort: m.defaultEffort } : {}),
    contextWindows: [...m.contextWindows],
  }));
  const listsLegacy = table.legacyListed === true;
  const folded = (m: HarnessModel): boolean => listsLegacy && m.isDefault !== true && table.legacyModels?.some(l => l.value === m.value) === true;
  const models = heard.filter(m => !folded(m));
  const legacyModels = table.legacyModels === undefined ? undefined : listsLegacy ? heard.filter(folded) : table.legacyModels.filter(l => !heard.some(m => m.value === l.value));
  // The binary named the effort its default model runs at, so its mark replaces the table's; where it named none the
  // table's own mark stands, and the picker shows a default either way.
  const defaultEffort = probe.models.find(m => m.isDefault)?.defaultEffort;
  const effort = (value: string): HarnessOption => {
    const base = known(table.efforts, value) ?? option(value, capitalize(value));
    if (defaultEffort === undefined) return base;
    const { isDefault: _fromTable, ...rest } = base;
    return value === defaultEffort ? { ...rest, isDefault: true } : rest;
  };
  return {
    ...table,
    source: "harness",
    version: probe.version,
    models,
    ...(legacyModels !== undefined ? { legacyModels } : {}),
    efforts: probe.efforts.map(effort),
    permissionModes: probe.permissionModes.map(value => known(table.permissionModes, value) ?? option(value, value)),
  };
}
