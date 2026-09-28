// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake api with three
// workspaces (running, paused, gone) and four threads, in either theme
// (?theme=light, each side's theme by id with ?lightTheme= and ?darkTheme=), with a toast over the centre pane (?toast=...) and with the
// runtime replacing the first machine's helper (?helper=1) or the first
// machine's link dropped after a near-full memory sample (?oom=1) or the
// napping machine's last vault refused for its size (?vault=1) or every
// probe failing before it left this computer (?offline=1), so a test
// can measure the chrome's geometry, which jsdom cannot lay out. With
// ?ws=<id> the centre holds that workspace's thread and composer, so the
// refusal line above the box can be measured for the running, paused and gone
// workspaces and the model picker's agent marks for their size and colour;
// ?ws=ws_a&linger=1 replays a turn that replied but whose process has not
// exited; ?ws=ws_a&chat=1 replays one whose reply is markdown of every kind the
// chat draws, so the message body and its code blocks can be measured, and
// whose init announced the CLI's slash commands, its own screens among them;
// ?local=1&ws=ws_m&perm=1 replays a turn on this computer with one permission
// prompt answered and one still open, so the relayed prompt row can be laid
// out and photographed in both states, and an option clicked or an access
// picked closes it the way the runtime's event does; &access=refused has that
// turn's harness refuse the change its own row said it takes, which is the one
// refusal the composer says under the box; ?local=1&ws=ws_m&fold=1 replays one
// that fanned out to three subagents, one holding a prompt of its own and one
// launched in the background, so a fold's body can be measured against its
// header; ?shell=desktop puts a desktop bridge on the page so the workspace
// switch chord reaches it; ?mac=1 marks the html the way the macOS preload
// does; ?panel=terminal opens the right panel with a Browser tab and a
// terminal over a fake daemon wire, the host answering a translucent Ghostty
// config, so the pane's material can be measured with each tab active;
// ?sidebar=<px> opens the sidebar at that remembered width so the rows can
// be measured at several; ?spaces=1 opens it in the Spaces body, one
// workspace under its header with an icon per workspace at the bottom;
// ?look=1 gives the first two workspaces a theme and the first a glyph of its own, ?ssh=1 adds a machine over ssh,
// ?many=<n> adds n more running forks so the space bar overflows;
// ?archived=1 gives the first workspace two threads quiet for days, so the
// Archived group nested in its idle shelf can be measured shut and opened;
// ?images=<n> puts n images in the composer so the thumbnail row above the
// text can be measured; ?size=file is the record saying the terminal's text size comes
// from the Ghostty file; ?local=1 puts this computer in the list beside the
// cloud machines, so a mixed list of both kinds can be measured; ?projects=1
// gives the first workspace two projects, its threads folders inside them and
// the record a last project for it, so the composer's project pick, the folder
// line under the box and the thread rows' project word can be measured, and
// this computer the same two and a third with a long name; ?efforts=1 gives
// the claude row its effort and context lists so the composer's row carries
// every picker; ?panel=preview opens the right panel inline with nothing in
// it, the narrowest the centre column gets at a width; ?panel=browser&at=<address>
// opens it on a browser tab framing that address, so the bar can be measured
// with a path and a query in it; ?export=1 opens the dialog that brings a
// folder home on ws_a; ?panel=machine opens the right panel on the Machine tab of
// the workspace ?ws names, so its PROJECTS section can be measured with two
// projects (ws_a under ?projects=1) and with none;
// ?places=1 fills the places list with four computers, one of them
// away with the longest name the spec draws; ?init=building puts the init job
// mid-build so the cloud row's progress line can be measured; ?version=behind holds a shell older than the host that
// served the page, so the one line the app says about it can be measured; ?host=1 runs the host-event rules on a
// prompt and a dead thread, so the notices they raise can be photographed.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { DAEMON_UPDATING, DEFAULT_PREFERENCES, DEFAULT_THEME, DESKTOP_MAC_CLASS, GOLDEN_STAGE_WORDS, SIGN_IN_OPEN_STATE, workspaceAccess, THEME_PRESETS, vaultOverCapLine, type HarnessCatalog, type SessionEvent, type SessionView, type TerminalConfig, type WorkspaceView } from "@wsp/protocol";
import { statusOf } from "../workspace-status";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api, ProtocolEvent } from "../../src/protocol/client";
import { getLive } from "../../src/machine/live";
import { useStore } from "../../src/protocol/store";
import { useHostNotices } from "../../src/notices/hostNotices.js";
import { addNotice } from "../../src/notices/store.js";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { useBrowserTabs } from "../../src/browser/tabs";
import { parseAddress } from "../../src/browser/url";
import { AppShell } from "../../src/shell/AppShell";
import { useShellVersionEffect } from "../../src/shell/shellVersion";
import { openPanelTerminal } from "../../src/shell/shellCommands";
import { WorkspaceThread } from "../../src/shell/WorkspaceThread";
import { useComposerImagesStore } from "../../src/components/chat/composerImages";
import { requestProjectTrip } from "../../src/shell/shellRequests";
import { GhosttyTerminalSurface } from "../../src/terminal/ghostty/surface";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../../src/terminal/link";
import { applyTheme } from "../../src/settings/theme";
import "../../src/index.css";
import { caps } from "../caps.js";
import { noDaemonApi } from "../fake-daemon-api.js";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
/** Each side's theme, by id (?lightTheme=, ?darkTheme=), the record's defaults where the query names none. */
const picks = { lightTheme: params.get("lightTheme") ?? DEFAULT_PREFERENCES.lightTheme, darkTheme: params.get("darkTheme") ?? DEFAULT_PREFERENCES.darkTheme };
applyTheme({ theme, ...picks }, theme === "dark");
document.documentElement.classList.toggle(DESKTOP_MAC_CLASS, params.get("mac") === "1");
// The bridge alone tells the page which shell holds it; with ?shell=desktop the chords a browser tab keeps for its
// own tabs reach the page, which is what the switcher's chord needs. It carries the two picture calls, which is what
// the switcher's well reads, and neither answers with a picture, so the wells draw empty.
if (params.get("shell") === "desktop") {
  window.wsp = { capturePreview: async () => undefined, workspacePreview: async () => undefined };
}
// The desktop's road: the folder picker is what a dialog draws for a folder on this computer.
if (params.get("export") === "1") window.wsp = { ...window.wsp, pickFolder: async () => undefined };

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt: "2026-09-05T11:00:00Z",
});
// The second workspace's copy is on a branch, so its row carries the meta line the two branchless rows have not.
const cloud: WorkspaceView[] = [
  view("ws_a", "api"),
  { ...view("ws_b", "web", "napping"), copy: { road: "clonefile", path: "/root/web", source: "/root/web", base: "abc", branch: "lockfile-bump", carried: "deps-and-config" } },
  { ...view("ws_c", "old", "gone"), gone: "machine m_ws_c is gone at the provider: Not found" },
];
// ?vault=1: the napping workspace's last nap could not store a vault, so its row says the machine has no backup
// since the day of the one that stands and the Machine tab names the cap the export was cut against.
if (params.get("vault") === "1") Object.assign(cloud[1]!, { vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: vaultOverCapLine(677_178_573, 209_715_200) });
// ?projects=1: two projects on the first workspace, as two imports leave them, with the sizes the imports measured.
const PROJECTS = [
  { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-04T10:00:00Z", size: 48_200_000 },
  { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-05T09:30:00Z", size: 133_000_000 },
];
const projects = params.get("projects") === "1";
if (projects) Object.assign(cloud[0]!, { projects: PROJECTS });
// ?local=1 adds this computer to the list, so a mixed list can be measured: two cloud rows and one local beside them.
// With ?longproject=1 its project has a name longer than the composer's picker row is wide in a narrow window: the one
// label a person names, which no width bounds.
const LONG_PROJECT = { id: "pr_long", name: "customer-billing-service-platform", path: "/Users/zingzy/customer-billing-service-platform", computer: "default" };
const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, golden: "", ...(projects ? { project: { id: "pr_api", name: "the-project", path: "/root", computer: "default" } } : {}), ...(params.get("longproject") === "1" ? { project: LONG_PROJECT } : {}) };
const workspaces = params.get("local") === "1" ? [...cloud, MAC] : cloud;
// ?look=1 gives the first two workspaces a theme and the first a glyph of its own, and leaves the rest with neither, so
// one page holds two themed spaces, a plain one and, with ?local=1 and ?ssh=1, every kind's own glyph on the bar. The
// first theme is a preset at the default grain and opacity; the second has three colours, grain and its own side pinned.
if (params.get("look") === "1") {
  Object.assign(workspaces[0]!, { theme: { ...DEFAULT_THEME, dots: [...THEME_PRESETS[1]!.dots], harmony: THEME_PRESETS[1]!.harmony }, glyph: "flask" });
  Object.assign(workspaces[1]!, { theme: { ...DEFAULT_THEME, dots: [...THEME_PRESETS[2]!.dots], harmony: THEME_PRESETS[2]!.harmony, grain: 0.5, opacity: 0.7, mode: "dark" } });
}
// ?ssh=1 adds a machine over ssh, the third kind, so the space bar can be shot with every kind's own glyph.
if (params.get("ssh") === "1") workspaces.push({ ...view("ws_s", "build-box"), kind: "ssh", machineId: "ssh:build-box", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, golden: "" });
// ?many=<n> adds n more running forks, so the space bar can be measured once its icons outgrow the footer.
for (let i = 0; i < Number(params.get("many") ?? 0); i++) workspaces.push(view(`ws_x${i}`, `extra-${i}`));
// The ticket's rows: long titles with the agent and both opener words. ws_a mixes a working thread with an idle
// one; ws_b has only idle ones, the shape that used to draw no Idle header at all, one of them on Codex so both a
// coloured and a monochrome agent mark sit in the shots.
// Two of the first workspace's threads quiet for days, added only with ?archived=1 so every other case keeps the
// four rows it measures: past the protocol's threshold they fold into the Archived group under that workspace's
// idle threads, which is what the group's own case reads.
const archived: SessionView[] = params.get("archived") !== "1"
  ? []
  : [
      { id: "s5", threadId: "s5", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "Rotate the daemon token and restart the host.", startedBy: "person", startedAt: Date.now() - 3 * 24 * 60 * 60_000, endedAt: Date.now() - 2 * 24 * 60 * 60_000 },
      { id: "s6", threadId: "s6", workspaceId: "ws_a", harness: "codex", status: "interrupted", prompt: "Drop the preview shim from the packing list.", startedBy: "cli", startedAt: Date.now() - 9 * 24 * 60 * 60_000, endedAt: Date.now() - 8 * 24 * 60 * 60_000 },
    ];
const sessions: SessionView[] = [
  // With ?projects=1 the first thread works in spoo and the second deep inside wsp, so both rows carry a project word.
  { id: "s1", threadId: "s1", workspaceId: "ws_a", harness: "claude", status: "running", prompt: "Now reply with exactly the word pong.", startedBy: "person", startedAt: Date.now() - 48 * 60_000, ...(projects ? { cwd: "/root/spoo" } : {}) },
  { id: "s2", threadId: "s2", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "Reply with exactly the word hi.", startedBy: "cli", startedAt: Date.now() - 30 * 60_000, endedAt: Date.now() - 24 * 60_000, ...(projects ? { cwd: "/root/wsp/packages/host" } : {}) },
  { id: "s3", threadId: "s3", workspaceId: "ws_b", harness: "codex", status: "completed", prompt: "Bump the lockfile and run the gate.", startedBy: "cli", startedAt: Date.now() - 90 * 60_000, endedAt: Date.now() - 80 * 60_000 },
  { id: "s4", threadId: "s4", workspaceId: "ws_b", harness: "claude", status: "interrupted", prompt: "Drop the old preview shim.", startedBy: "person", startedAt: Date.now() - 120 * 60_000, endedAt: Date.now() - 110 * 60_000 },
  ...archived,
];

// Two agents the composer can start a thread on, so its picker draws a coloured mark and a monochrome one. Codex
// carries the effort lists its app-server reports, each model with the effort that model runs at, so the effort
// picker draws its default against a pick rather than against the binary.
// The access modes are the CLI's own list, and workspaceAccess turns it into the list the runtime hands out for a
// workspace on this computer: the mode a thread here starts at marked, and bypass named after the machine it would
// touch. One list serves every workspace here, which is what a fixture can do; the runtime decides per workspace.
const ACCESS_MODES = [
  { value: "default", label: "Default", description: "Asks in the chat about each action that needs permission" },
  { value: "acceptEdits", label: "Accept edits", description: "Edits files without asking; asks about commands that need permission" },
  { value: "plan", label: "Plan", description: "Reads and plans only; changes nothing" },
  { value: "bypassPermissions", label: "Bypass", description: "Runs every action without asking" },
];
// ?efforts=1 gives the claude row the effort levels and context windows the runtime's table lists for it, so the
// composer's row carries the effort picker beside the others and is as wide as it gets.
const efforts = params.get("efforts") === "1";
const CLAUDE_EFFORTS = ["Low", "Medium", "High", "Extra high", "Max"].map(label => ({ value: label.toLowerCase().replace(" ", ""), label, ...(label === "High" ? { isDefault: true } : {}) }));
const CLAUDE_CONTEXT_WINDOWS = [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }];

const catalogs: HarnessCatalog[] = [
  workspaceAccess(
    {
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.257",
      models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: efforts ? ["200k", "1m"] : [] }],
      efforts: efforts ? CLAUDE_EFFORTS : [],
      contextWindows: efforts ? CLAUDE_CONTEXT_WINDOWS : [],
      permissionModes: ACCESS_MODES,
      steers: true,
      renames: true,
      images: true,
      movesAccess: true,
      keptMode: "default",
      bypassMode: "bypassPermissions",
      // The CLI's own screens, as the runtime's table names them; the chat replay announces them beside the rest.
      screenCommands: [
        { name: "login", control: "sign-in" },
        { name: "logout", control: "sign-in" },
        { name: "model", control: "model" },
        { name: "permissions", control: "access" },
        { name: "config", control: "settings" },
        { name: "help", control: "docs" },
      ],
    },
    "local",
  ),
  {
    harness: "codex",
    label: "Codex",
    source: "table",
    version: "app-server 0.153.0, 2026-09-07",
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "low" },
      { value: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
    efforts: [{ value: "low", label: "Low", isDefault: true }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }],
    contextWindows: [],
    permissionModes: [],
    steers: false,
    renames: false,
    images: false,
  },
];

/** A turn on this computer with a permission prompt open and one already answered, so the row can be laid out and
 * photographed in both states; the local kind is what starts a thread at the access its harness asks in. */
const perm = { workspaceId: MAC.id, sessionId: "s_perm", turnId: "turn_perm", threadId: "thr_perm" };
const permOptions = [
  { id: "allow", label: "Allow", effect: "allow" as const },
  { id: "deny", label: "Deny", effect: "deny" as const },
  { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode" as const, mode: "acceptEdits" },
];
/** A page about two kilobytes long, the size the persona's prompt pasted into the chat before this row folded it. */
const LANDING_PAGE = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
  "    <title>Health</title>",
  "    <style>",
  "      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; color: #18181b; }",
  "      main { max-width: 38rem; margin: 0 auto; }",
  "      h1 { font-size: 2rem; margin: 0 0 1rem; }",
  "      p { margin: 0 0 1rem; }",
  "      code { font-family: ui-monospace, monospace; background: #f4f4f5; padding: 0.1rem 0.3rem; }",
  "    </style>",
  "  </head>",
  "  <body>",
  "    <main>",
  "      <h1>The api is up</h1>",
  "      <p>",
  "        This page is served by the health route. If you can read it, the process started, the port was free",
  "        and the router matched. Nothing on it is clever, and that is on purpose.",
  "      </p>",
  "      <p>",
  '        The route answers <code>GET /health</code> with <code>{ "ok": true }</code> and this page with the same',
  "        words a person can read. One of the two is for a machine and the other is for whoever is paged at",
  "        three in the morning.",
  "      </p>",
  "      <p>",
  "        There is no script tag here and no stylesheet to fetch, so a browser that draws nothing is telling you",
  "        about the network rather than about the page.",
  "      </p>",
  "    </main>",
  "  </body>",
  "</html>",
  "",
].join("\n");

const prompting: SessionEvent[] = [
  { type: "session.start", ...perm, prompt: "Add a health route and run the tests." },
  { type: "session.delta", ...perm, kind: "text", text: "I will add the route, then run the suite." },
  {
    type: "session.permission",
    ...perm,
    askId: "ask_done",
    toolName: "Write",
    toolUseId: "toolu_1",
    input: JSON.stringify({ file_path: "/Users/zingzy/api/src/health.ts", content: "export const health = () => ({ ok: true });\n" }),
    detail: "health.ts",
    options: permOptions,
  },
  { type: "session.permission.closed", ...perm, askId: "ask_done", outcome: "allowed", optionId: "allow" },
  {
    type: "session.permission",
    ...perm,
    askId: "ask_open",
    toolName: "Bash",
    toolUseId: "toolu_2",
    input: JSON.stringify({ command: "pnpm exec vitest run --minWorkers=1 --maxWorkers=1 packages/api/test/health.test.ts packages/api/test/routes.test.ts", description: "Run the health route's test" }),
    detail: "pnpm exec vitest run",
    options: permOptions,
  },
  // A page of the size a person really meets, so the rule that an opened file leaves the buttons on the screen can
  // be measured rather than asserted.
  {
    type: "session.permission",
    ...perm,
    askId: "ask_file",
    toolName: "Write",
    toolUseId: "toolu_4",
    input: JSON.stringify({ file_path: "/Users/zingzy/api/public/index.html", content: LANDING_PAGE }),
    detail: "index.html",
    options: permOptions,
  },
  // One token longer than any row is wide, so the rule that a command is never broken inside a token can be measured.
  {
    type: "session.permission",
    ...perm,
    askId: "ask_long",
    toolName: "Bash",
    toolUseId: "toolu_3",
    input: JSON.stringify({ command: `curl -fsSL https://registry.example.com/artifacts/${"a1b2c3d4e5".repeat(15)}/health.tar.gz` }),
    options: permOptions,
  },
];

/** The prompts the replay leaves open, and the page's own watchers: a click on an option and an access picked while
 * the turn runs both close a prompt here the way the runtime's event does, so the row goes on the page. */
const openAsks = new Set(prompting.filter(e => e.type === "session.permission").map(e => e.askId));
for (const closed of prompting) if (closed.type === "session.permission.closed") openAsks.delete(closed.askId);
const watching = new Set<(event: ProtocolEvent) => void>();
const closePrompt = (askId: string, optionId: string): void => {
  if (!openAsks.delete(askId)) return;
  const closed: SessionEvent = { type: "session.permission.closed", ...perm, askId, outcome: optionId === "deny" ? "denied" : "allowed", optionId };
  prompting.push(closed);
  for (const fn of watching) fn(closed);
};

/** A turn that fanned out to three subagents, so the fold's own geometry can be measured against its header: two
 * running, one of them holding a prompt, one finished, and one launched in the background whose only answer so far
 * is the harness's note that it started. */
const fan = { workspaceId: MAC.id, sessionId: "s_fan", turnId: "turn_fan", threadId: "thr_fan" };
const LAUNCH_NOTE =
  "Async agent launched successfully. (This tool result is internal metadata, never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a057760";
const launched = (id: string, description: string): SessionEvent => ({
  type: "session.delta", ...fan, kind: "tool_use", toolName: "Agent", toolUseId: id,
  text: JSON.stringify({ description, prompt: "go", subagent_type: "general-purpose" }),
});
const folding: SessionEvent[] = [
  { type: "session.start", ...fan, prompt: "Count the alpha files, read beta's hostname, and watch gamma's disk." },
  { type: "session.delta", ...fan, kind: "text", text: "Launching all three now." },
  launched("toolu_a", "count alpha files"),
  launched("toolu_b", "read beta hostname"),
  launched("toolu_c", "check gamma disk"),
  { type: "session.delta", ...fan, kind: "tool_result", toolUseId: "toolu_c", text: LAUNCH_NOTE },
  { type: "session.delta", ...fan, kind: "text", text: "Reading the listing.", parentToolUseId: "toolu_a" },
  {
    type: "session.permission", ...fan, askId: "ask_child", toolName: "Bash", toolUseId: "toolu_a1",
    parentToolUseId: "toolu_a", input: JSON.stringify({ command: "ls /etc | head -3" }), options: permOptions,
  },
  { type: "session.delta", ...fan, kind: "text", text: "Ran hostname.", parentToolUseId: "toolu_b" },
  { type: "session.delta", ...fan, kind: "tool_result", toolUseId: "toolu_b", text: "dogfood-b1" },
  { type: "session.delta", ...fan, kind: "text", text: "Root has 28G free.", parentToolUseId: "toolu_c" },
];

const linger = { workspaceId: "ws_a", sessionId: "s1", turnId: "turn_1", threadId: "thr_linger" };
const lingering: SessionEvent[] = [
  { type: "session.start", ...linger, prompt: "Start the dev server in the background and reply when it is up." },
  { type: "session.delta", ...linger, kind: "text", text: "Server is live at :3000." },
  { type: "session.done", ...linger, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
];

// ?chat=1 replays one answered turn whose reply is the markdown the chat actually has to draw: prose, a
// sentence with inline code in it, a fenced block the highlighter colours, a quote, a list and a table. It is
// the surface the ticket names, and the parts that can go wrong in light are the ones that carry their own
// ground: a code block, an inline code chip and a quote's rule all sit on a near-white card.
const chatTurn = { workspaceId: "ws_a", sessionId: "s1", turnId: "turn_2", threadId: "thr_chat" };
const CHAT_MARKDOWN = [
  "Bumped the lockfile and ran the gate. The failing file was `apps/web/test/tokens.test.ts`, which pins",
  "the stylesheet's additions, so the new token needed the snapshot taken again.",
  "",
  "```ts",
  'const ROW_META_CLASS = "font-mono text-[11px] tabular-nums";',
  "export function metaLine(project: Project): string {",
  "  // A machine wsp does not drive says what it is instead of what it costs.",
  "  return driven(project) ? costLine(project) : machineLine(project);",
  "}",
  "```",
  "",
  "> The gate runs once, on the branch merged with origin/main in a fresh worktree.",
  "",
  "- `pnpm test` green without creds",
  "- `tsc --noEmit` clean",
  "",
  "| file | tests | state |",
  "| --- | --- | --- |",
  "| tokens.test.ts | 5 | green |",
  "| sidebar.test.tsx | 55 | green |",
  "",
  "Full notes in [the tracker](https://example.invalid/439).",
].join("\n");
// The init's slash_commands as the CLI lists them: the built-ins that run headless, its own screens, and a skill.
const CHAT_SLASH_COMMANDS = ["compact", "context", "cost", "init", "review", "login", "logout", "model", "permissions", "config", "help", "unslop"];
const chatHistory: SessionEvent[] = [
  { type: "session.start", ...chatTurn, prompt: "Bump the lockfile and run the gate.", harness: { slashCommands: CHAT_SLASH_COMMANDS } },
  { type: "session.delta", ...chatTurn, kind: "text", text: CHAT_MARKDOWN },
  { type: "session.done", ...chatTurn, result: { status: "completed", durationMs: 2400, costUsd: 0.004 } },
];

const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async id => workspaces.find(w => w.id === id)!,
  createWorkspace: async () => workspaces[0]!,
  watchStatuses: async () =>
    workspaces.map(w =>
      w.id === MAC.id
        ? statusOf(w, { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, facts: { os: "macOS 15.5", uptimeMs: 3 * 86_400_000 + 4 * 3_600_000, folder: "/Users/zingzy/wsp" } })
        : statusOf(w, params.get("offline") === "1" ? { reach: { state: statusOf(w).reach.state, offline: true } } : w.id !== "ws_a" ? {} : params.get("helper") === "1" ? { daemonNote: DAEMON_UPDATING } : params.get("oom") === "1" ? { reach: { state: "unreachable" } } : { idleAt: Date.now() + 15.5 * 60_000 }),
    ),
  forget: async () => {},
  nap: async id => workspaces.find(w => w.id === id)!,
  wake: async id => workspaces.find(w => w.id === id)!,
  capabilities: async () => (caps()),
  startSession: async o => ({ id: "s2", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async id =>
    id === MAC.id
      ? params.get("perm") === "1"
        ? prompting
        : params.get("fold") === "1"
          ? folding
          : []
      : id !== "ws_a"
        ? []
        : params.get("chat") === "1"
          ? chatHistory
          : params.get("linger") === "1"
            ? lingering
            : [],
  // The row closes on the runtime's own event and never on this reply, so the fixture pushes it: a click on an
  // option has to be seen landing, not only counted.
  answerPermission: async (sessionId, askId, optionId) => {
    closePrompt(askId, optionId);
    return "answered";
  },
  // The pick reaches the running turn, and the prompt it is stopped on goes with it where the mode answers one.
  // ?access=refused is the harness taking back what its row said it would take, which is the one thing the composer
  // says under the box.
  setSessionAccess: async (_sessionId, permissionMode) => {
    if (params.get("access") === "refused") return "unsupported";
    if (permissionMode === "bypassPermissions" || permissionMode === "acceptEdits") for (const askId of [...openAsks]) closePrompt(askId, "allow");
    return "set";
  },
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => sessions,
  // The runtime keeps the name on the row, so the next listing carries it; the shell fixture does the same.
  renameSession: async (sessionId, title) => {
    const row = sessions.find(s => s.id === sessionId);
    if (row !== undefined) row.harnessTitle = title;
    return { outcome: "renamed" };
  },
  // The runtime holds the name on this computer, so the next listing carries it; the shell fixture does the same.
  renameWorkspace: async (id, name) => {
    const row = workspaces.find(w => w.id === id)!;
    row.name = name;
    return row;
  },
  // The look sits on the record beside the name, so the fixture writes it there and answers with the row.
  setWorkspaceLook: async (id, look) => {
    const row = workspaces.find(w => w.id === id)!;
    if (look.theme !== undefined) {
      if (look.theme === null) delete row.theme;
      else row.theme = look.theme;
    }
    if (look.glyph !== undefined) {
      if (look.glyph === null) delete row.glyph;
      else row.glyph = look.glyph;
    }
    return row;
  },
  listHarnesses: async () => catalogs,
  subscribe: fn => {
    watching.add(fn);
    return () => watching.delete(fn);
  },
  getGolden: async () => undefined,
  hostTerminalConfig: async () => TRANSLUCENT,
  listProjectGoldens: async () => [],
  snapshotWorkspace: async id => ({ snapshotId: "snap_taken", projects: PROJECTS, golden: "snap_g", workspaceId: id, workspaceName: "api", createdAt: new Date().toISOString() }),
};

/** A Ghostty config with a background-opacity under 1, the shape whose translucency belongs to the canvas alone, and a
 * font-size of 16, the size the pane's cells must take from the file. */
const TRANSLUCENT: TerminalConfig = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], fontSize: 16, palette: Array<null>(16).fill(null), windowPaddingX: { left: 14, right: 14 }, windowPaddingY: { top: 14, bottom: 14 }, backgroundOpacity: 0.85 };

/** A daemon that holds the ptys the page opens and answers nothing else. */
function fakeWire(): TerminalWire {
  const held = new Set<string>();
  return {
    request: async (op, params = {}) => {
      if (op === "pty.create") {
        const ptyId = `p${held.size + 1}`;
        held.add(ptyId);
        return { ok: true, ptyId };
      }
      if (op === "pty.kill") held.delete(String(params["ptyId"]));
      if (op === "pty.list") return { ok: true, ptys: [...held].map(id => ({ id, pid: 1, cols: 80, rows: 24, exited: false })) };
      return { ok: true };
    },
  };
}

// ?version=behind puts a shell older than the host that served this page on the window, so the one line the app
// says about it can be measured where it lands; the whole road runs, bridge and boot object both.
if (params.get("version") === "behind") {
  window.wsp = { ...window.wsp, version: "0.1.3" };
  (window as unknown as { __WSP__?: { wsPort: number; paired: boolean; version: string } }).__WSP__ = { wsPort: 0, paired: true, version: "0.1.5" };
}
const toast = params.get("toast");
const shown = params.get("ws");
useStore.setState({ conn: "live", ...(shown !== null ? { selectedId: shown } : {}) });
if (toast !== null) addNotice({ kind: "error", text: toast, where: params.get("where") ?? "spoo" });
// ?sidebar=<px> is the width the host's record holds, and ?spaces=1 the body it holds; the fixture's api answers no
// preferences op, so the record is put in place here as the host's answer would put it. The shell is where the
// surfaces behind labs are shot, so labs is on unless ?labs=0 asks for the record a host without it serves.
const sidebarWidth = params.get("sidebar");
useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme, ...picks, labs: params.get("labs") !== "0", ...(sidebarWidth !== null ? { sidebarWidth: Number(sidebarWidth) } : {}), ...(params.get("spaces") === "1" ? { sidebarMode: "spaces" as const } : {}), ...(params.get("size") === "file" ? { terminalSize: "file" as const } : {}), ...(projects ? { project: { ws_a: "spoo", ws_m: "spoo" } } : {}) } });
// ?places=1 fills the places list with the worst row the spec draws, a computer away with a long name beside
// this Mac and a provider, so the pane's rows can be measured against a full list at every window.
if (params.get("places") === "1") {
  useStore.setState({
    places: [
      { id: "p_here", kind: "computer", name: "zingzy-mbp", default: true, present: true, shape: { cpu: 10, memMb: 16384 }, diskFreeBytes: 210_000_000_000, takesForks: false },
      { id: "p_hetzner", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38_000_000_000, forks: { running: 0, room: 3 } },
      // The worst row the detail draws: a computer away with a login on its record and the longest refusal ssh
      // hands back, which is the line that used to push the table past the card it sits in.
      {
        id: "p_laptop",
        kind: "computer",
        name: "old-macbook",
        default: false,
        present: false,
        lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        shape: { cpu: 10, memMb: 16384 },
        diskFreeBytes: 353_100_000_000,
        takesForks: true,
        road: { ssh: "root@65.21.4.12" },
        dialled: { at: new Date(Date.now() - 20 * 60_000).toISOString(), answered: false, said: "ssh: connect to host 65.21.4.12 port 22: Connection refused" },
      },
      { id: "p_ascii", kind: "provider", name: "ascii", default: false, present: true, shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 40_000_000_000, takesForks: true, rateUsdPerHour: 0.018 },
    ],
  });
}
/** The app's own reading of the two halves, so ?version=behind runs the road the app runs and not a set toast. */
function VersionRule() {
  useShellVersionEffect();
  return null;
}
useStore.getState().bind(api);
// ?init=building puts the init job mid-build on the store, as its events would, so the collapsed cloud row's progress
// line can be measured and photographed; the fixture's golden is none, so the row is there.
if (params.get("init") === "building") {
  useStore.setState({
    initJob: {
      id: "init_1",
      road: "manual",
      phase: "building",
      keys: { solari: true },
      step: 0,
      stoppable: true,
      screens: [],
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done", ms: 14_000 },
        { id: "stage/deploying-daemon", kind: "stage", label: GOLDEN_STAGE_WORDS["deploying-daemon"], state: "running", detail: "node v22", lines: ["apt-get install -y git curl", "node v22"] },
        { id: "stage/applying-setup", kind: "stage", label: GOLDEN_STAGE_WORDS["applying-setup"], state: "waiting" },
        { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "waiting" },
      ],
      progress: { done: 1, total: 4 },
      log: [],
    },
  });
}
// ?init=waiting puts the job at a sign-in whose page waits for the person, two of four stages over, so the button's
// paused spinner and its words can be measured.
if (params.get("init") === "waiting") {
  useStore.setState({
    initJob: {
      id: "init_1",
      road: "manual",
      phase: "signing-in",
      keys: { solari: true },
      step: 0,
      stoppable: true,
      screens: [],
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done", ms: 14_000 },
        { id: "stage/deploying-daemon", kind: "stage", label: GOLDEN_STAGE_WORDS["deploying-daemon"], state: "done", ms: 40_000 },
        { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" },
        { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "waiting" },
      ],
      progress: { done: 2, total: 4 },
      needsYou: { what: "sign in to GitHub CLI login", since: Date.now() },
      log: [],
    },
  });
}
// The meter's tick for the running machine, so its row's second line reads cost, rate and countdown together.
useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 2 * 3_600_000, accruedUsd: 0.29, at: new Date().toISOString() });
// ?panel=preview opens the right panel inline with nothing in it, the narrowest the centre column gets at a width.
if (params.get("panel") === "preview" && shown !== null) {
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.getState().open(shown, "preview");
}
// The fake route's host resolves nowhere, so the frame under the bar stays blank.
const at = params.get("at");
if (params.get("panel") === "browser" && shown !== null && at !== null) {
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.getState().open(shown, "preview");
  useRightPanelStore.getState().openBrowser(shown, useBrowserTabs.getState().createTab(shown, parseAddress(at)));
}
if (params.get("panel") === "terminal" && shown !== null) {
  const surfaces: GhosttyTerminalSurface[] = [];
  const create = GhosttyTerminalSurface.create.bind(GhosttyTerminalSurface);
  GhosttyTerminalSurface.create = async (mount, options) => { const s = await create(mount, options); surfaces.push(s); return s; };
  Object.assign(window, { surfaces });
  const terminals = new WorkspaceTerminals(fakeWire());
  terminals.feedStatus("live");
  provideTerminals(shown, terminals);
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.getState().open(shown, "preview");
  void openPanelTerminal(shown);
}
// ?images=<n> puts n images in the composer, as a paste would, so the thumbnail row can be measured; the bytes are a
// tiny gradient of a known colour, since what is measured is the row and not the picture.
if (params.get("images") !== null) {
  const swatch = (hue: number): File => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = `hsl(${hue} 70% 55%)`;
    ctx.fillRect(0, 0, 32, 32);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), c => c.charCodeAt(0));
    return new File([bytes], `shot-${hue}.png`, { type: "image/png" });
  };
  const count = Number(params.get("images")) || 1;
  void useComposerImagesStore.getState().add(shown ?? "ws_a", Array.from({ length: count }, (_, i) => swatch(i * 60)));
}
if (params.get("oom") === "1") {
  const GiB = 1024 ** 3;
  getLive("ws_a").feedStatus("live");
  getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
  getLive("ws_a").feedStatus("connecting");
}
/** The app's own host-event rules, so ?host=1 runs the road a prompt and a dead thread take and not a set toast:
 * both land on a workspace not open, pushed from an effect after the rules' own, so they are listening. */
function HostRule() {
  useHostNotices();
  useEffect(() => {
    const events: ProtocolEvent[] = [
      { type: "session.end", workspaceId: "ws_b", sessionId: "s2", turnId: "turn_s2", threadId: "s2", exitCode: 1, sawResult: false, seq: 900 },
      { type: "session.permission", workspaceId: "ws_b", sessionId: "s_host", turnId: "turn_host", threadId: "thr_host", askId: "ask_host", toolName: "Bash", detail: "Check the version", input: '{"command":"wsp --version"}', options: permOptions, seq: 901 },
    ];
    for (const event of events) for (const fn of watching) fn(event);
  }, []);
  return null;
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {params.get("version") === "behind" ? <VersionRule /> : null}
    {params.get("host") === "1" ? <HostRule /> : null}
    <AppShell>
      {shown === null ? (
        <div />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
          <WorkspaceThread workspaceId={shown} />
        </div>
      )}
    </AppShell>
  </TooltipProvider>,
);
// ?export=1: the dialog that brings a folder home, asked for once the sidebar is listening.
if (params.get("export") === "1") {
  const ask = (): void => {
    if (document.querySelector("[data-sidebar-row]") === null) setTimeout(ask, 20);
    else requestProjectTrip({ workspaceId: "ws_a", trip: "export" });
  };
  ask();
}
