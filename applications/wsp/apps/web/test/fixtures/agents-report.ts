// SPDX-License-Identifier: AGPL-3.0-only
// One agents report with every row the three segments draw: an agent wsp's
// recipe put on with a newer version out and the catalog pinning an older
// one, one the person installed with no sign-in, one behind a shim whose
// sign-in nobody checked, and one not on the PATH; a skill in the shared
// folder linked into three agents, a plugin's, a project's and the one wsp
// writes; stdio and http servers in every state, the wsp server among them,
// one set up for two agents that disagree about its sign-in and one in the
// project; two readers that could not answer. Shared by the render tests and
// the wireframe.
import type { AgentsReport, ServerToolsAnswer, SkillHit, SkillPreview } from "@wsp/protocol";

/** The project a task on the box works, whose own skill and server the report carries. */
const WSP_PROJECT = { id: "pr_wsp", name: "wsp", path: "~/wsp" };

export const AGENTS_REPORT: AgentsReport = {
  target: { placeId: "p_spoo" },
  home: "/home/ada",
  user: "ada",
  readAt: "2026-09-24T12:00:00.000Z",
  agents: [
    { id: "claude", name: "Claude Code", installed: true, version: "2.1.281", latest: "2.1.282", pinned: "2.1.280", road: "wsp", path: "/opt/wsp/bin/claude", via: "cmux", signIn: "signed-in", signInRoad: "token", wspTools: true },
    { id: "codex", name: "Codex", installed: true, version: "0.62.0", road: "own", path: "~/.local/bin/codex", signIn: "none", signInRoad: "device", wspTools: true },
    { id: "opencode", name: "OpenCode", installed: true, version: "1.14.2", road: "shim", via: "mise", signIn: "unknown", signInRoad: "terminal", wspTools: false },
    { id: "pi", name: "Pi", installed: false, latest: "0.84.4", road: "none", signIn: "unknown", signInRoad: "terminal", wspTools: false },
  ],
  skills: [
    {
      name: "frontend-design",
      description: "Create distinctive, production-grade frontend interfaces with high design quality.",
      scope: "user",
      paths: [
        { path: "~/.claude/skills/frontend-design", agent: "claude", linkTo: "~/.agents/skills/frontend-design" },
        { path: "~/.agents/skills/frontend-design" },
        { path: "~/.codex/skills/frontend-design", agent: "codex" },
        { path: "~/.config/opencode/skills/frontend-design", agent: "opencode" },
      ],
    },
    { name: "pdf", scope: "plugin", paths: [{ path: "~/.claude/plugins/cache/anthropics/skills/pdf", agent: "claude" }] },
    { name: "wsp-review", scope: "project", paths: [{ path: "~/wsp/.agents/skills/wsp-review" }], project: WSP_PROJECT },
    { name: "wsp", description: "Run work on wsp workspaces from inside an agent.", scope: "user", paths: [{ path: "~/.claude/skills/wsp", agent: "claude" }] },
  ],
  servers: [
    { agent: "claude", name: "airtable", scope: "user", file: "~/.claude.json", transport: { kind: "stdio", line: "npx -y airtable-mcp-server" }, envNames: ["AIRTABLE_API_KEY"], auth: "open", enabled: true, inRecipe: true },
    {
      agent: "opencode",
      name: "github",
      scope: "user",
      file: "~/.config/opencode/opencode.json",
      transport: { kind: "stdio", line: "npx -y @modelcontextprotocol/server-github" },
      envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      auth: "open",
      enabled: true,
      inRecipe: false,
    },
    { agent: "codex", name: "notion", scope: "user", file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.notion.com" }, envNames: ["Authorization"], auth: "unknown", enabled: true },
    { agent: "claude", name: "notion", scope: "user", file: "~/.claude.json", transport: { kind: "http", host: "mcp.notion.com" }, envNames: [], auth: "needs-sign-in", enabled: true },
    { agent: "claude", name: "spoo-metrics", scope: "project", file: "~/wsp/.mcp.json", transport: { kind: "stdio", line: "node scripts/metrics-mcp.js --token ${METRICS_TOKEN}" }, envNames: ["METRICS_TOKEN"], auth: "open", enabled: true, project: WSP_PROJECT },
    { agent: "claude", name: "linear", scope: "user", file: "~/.claude.json", transport: { kind: "http", host: "mcp.linear.app" }, envNames: [], auth: "needs-sign-in", enabled: true },
    { agent: "codex", name: "sentry", scope: "user", file: "~/.codex/config.toml", transport: { kind: "http", host: "mcp.sentry.dev" }, envNames: [], auth: "failed", enabled: false },
    { agent: "claude", name: "wsp", scope: "user", file: "~/.claude.json", transport: { kind: "stdio", line: "wsp mcp" }, envNames: [], auth: "open", enabled: true },
  ],
  refused: ["skills: the answer was cut short, so the list is not whole", "~/.hermes/config.yaml is over 1 MB and was not read"],
  projects: [WSP_PROJECT],
};

/** The box's report as its page reads it, over the two projects it holds: wsp's rows, and spoo's own server and
 * skill. */
const SPOO_PROJECT = { id: "pr_spoo", name: "spoo", path: "~/spoo" };
export const AGENTS_PAGE_REPORT: AgentsReport = {
  ...AGENTS_REPORT,
  projects: [SPOO_PROJECT, WSP_PROJECT],
  skills: [
    ...AGENTS_REPORT.skills,
    { name: "release", description: "Cut a spoo release.", scope: "project", paths: [{ path: "~/spoo/.claude/skills/release", agent: "claude" }], project: SPOO_PROJECT },
  ],
  servers: [
    ...AGENTS_REPORT.servers,
    { agent: "claude", name: "postgres", scope: "project", file: "~/spoo/.mcp.json", transport: { kind: "stdio", line: "npx -y @modelcontextprotocol/server-postgres" }, envNames: ["DATABASE_URL"], auth: "open", enabled: true, project: SPOO_PROJECT },
  ],
};

/** What List tools answers per server in the wireframe: airtable's tools, one description long enough to clamp;
 * github that did not answer in time. */
export const SERVER_TOOLS: Readonly<Record<string, ServerToolsAnswer>> = {
  airtable: {
    auth: "connected",
    readAt: "2026-09-24T12:00:00.000Z",
    tools: [
      { name: "list_records", description: "List records in a table, filtered by a formula and sorted by any field, a page of up to one hundred records at a time with the offset for the next page.",
        params: [
          { name: "baseId", type: "string", required: true, description: "The base the table is in, as appXXXXXXXXXXXXXX." },
          { name: "tableId", type: "string", required: true, description: "The table's id or its name." },
          { name: "filterByFormula", type: "string", required: false, description: "A formula a record has to answer true to." },
          { name: "maxRecords", type: "integer", required: false },
        ],
      },
      { name: "create_record", description: "Create a record in a table." },
      { name: "list_bases" },
    ],
  },
  github: { auth: "failed", refused: "Did not answer in 20 s.", readAt: "2026-09-24T12:00:00.000Z" },
  linear: { auth: "needs-sign-in", holder: "claude", readAt: "2026-09-24T12:00:00.000Z" },
  notion: { auth: "signed-in", holder: "claude", readAt: "2026-09-24T12:00:00.000Z" },
};

const FRONTEND_DESIGN_MD = `---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality.
license: Apache-2.0
---

# Frontend design

Pick one bold direction before writing a line, and hold it through every screen.

## When to use it

- A new page, component or app shell that should not look generated.
- A redesign where the brief names a mood rather than a layout.

## How

1. Name the direction in one sentence.
2. Choose two typefaces and one accent, and write them down.
3. Build the smallest screen that shows all three.

\`\`\`css
:root { --accent: oklch(0.72 0.17 45); }
\`\`\`

See [the reference](https://skills.sh) for worked examples.
`;

/** What each installed skill's preview answers in the wireframe. */
export const SKILL_PREVIEWS: Readonly<Record<string, SkillPreview>> = {
  "frontend-design": { text: FRONTEND_DESIGN_MD, size: FRONTEND_DESIGN_MD.length },
};

/** What a skills.sh search answers in the wireframe: a few results, one already installed. */
export const SKILL_HITS: readonly SkillHit[] = [
  { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 3_612_000 },
  { id: "vercel-labs/agent-skills/vercel-react-best-practices", source: "vercel-labs/agent-skills", skillId: "vercel-react-best-practices", name: "vercel-react-best-practices", installs: 1_204_000 },
  { id: "anthropics/skills/docx", source: "anthropics/skills", skillId: "docx", name: "docx", installs: 192_764 },
  { id: "acme/kit/frontend-design", source: "acme/kit", skillId: "frontend-design", name: "frontend-design", installs: 12_400 },
];

/** A SKILL.md out to do everything a file nobody here wrote must not: fetch an image, run a script, open a file on
 * this computer. The restricted renderer draws it all as text but the one web link and the one heading link. */
export const HOSTILE_SKILL_MD = [
  "---",
  "name: hostile",
  "---",
  "# Hostile",
  "",
  "![pixel](https://example.test/p.gif)",
  "",
  '<img src="https://example.test/p.gif">',
  "",
  "<script>alert(1)</script>",
  "",
  "[run](./scripts/run.py) [abs](/Users/zingzy/.zshrc) [hosts](file:///etc/hosts)",
  "",
  "`/etc/hosts`",
  "",
  "[site](https://skills.sh) [usage](#usage)",
  "",
  "## Usage",
  "",
].join("\n");
