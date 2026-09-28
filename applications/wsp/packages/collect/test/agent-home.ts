// SPDX-License-Identifier: AGPL-3.0-only
// A home as six harnesses leave one: skills as copies and as links into the
// shared folder, Hermes' category folders, dot entries, a plugin's skills, an
// MCP config per agent with secrets in it, login files beside them, and a
// project with its own skills and servers. Every value a reader must never
// print carries SECRET, and every server command writes SPAWNED when run.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SECRET = "sk-fixture-SECRET";

const skill = (name: string, description: string, extra = ""): string => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody that is never read past the frontmatter.\n`;

export interface AgentHome {
  home: string;
  bin: string;
  project: string;
}

export function agentHome(root: string): AgentHome {
  const home = join(root, "home");
  const bin = join(root, "bin");
  const project = join(home, "code", "app");
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const link = (target: string, path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  };
  const h = (p: string): string => join(home, p);

  // Skills.
  put(h(".agents/skills/pdf/SKILL.md"), skill("pdf", ">\n  Read and fill\n  PDF forms"));
  put(h(".agents/skills/.hidden/SKILL.md"), skill("hidden", "a dot folder is no skill"));
  put(h(".agents/skills/.DS_Store"), "");
  link("../../.agents/skills/pdf", h(".claude/skills/pdf"));
  put(h(".claude/skills/review/SKILL.md"), skill("review", '"Review a diff"'));
  put(h(".claude/skills/review/examples/inner/SKILL.md"), skill("inner", "a skill's own example is no skill"));
  put(h(".codex/skills/pdf/SKILL.md"), skill("pdf", "Read and fill PDF forms"));
  put(h(".gemini/skills/sql/SKILL.md"), skill("sql", "'Query databases'"));
  put(h(".config/opencode/skills/sql/SKILL.md"), skill("sql", "Query databases"));
  link("../../../.agents/skills/pdf", h(".pi/agent/skills/pdf"));
  put(h(".hermes/skills/software-development/plan/SKILL.md"), skill("plan", "Plan the work"));
  put(h(".hermes/skills/.hub/cached/SKILL.md"), skill("cached", "the hub's cache is no skill"));
  mkdirSync(h(".hermes/skills/notes"), { recursive: true });
  const plugin = h(".claude/plugins/cache/official/frontend/abc123");
  const projectPlugin = h(".claude/plugins/cache/official/other/def456");
  put(join(plugin, "skills/frontend-design/SKILL.md"), skill("frontend-design", "Design frontends"));
  put(join(projectPlugin, "skills/project-only/SKILL.md"), skill("project-only", "a project's plugin"));
  put(
    h(".claude/plugins/installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "frontend@official": [{ scope: "user", installPath: plugin }], "other@official": [{ scope: "project", projectPath: project, installPath: projectPlugin }] } }),
  );

  // MCP servers, one config per agent the catalog names a format for.
  put(
    h(".claude.json"),
    JSON.stringify({
      mcpServers: {
        airtable: { command: "npx", args: ["-y", "airtable-mcp-server"], env: { AIRTABLE_API_KEY: SECRET } },
        notion: { type: "http", url: "https://mcp.notion.com/mcp" },
        wsp: { command: join(root, "wsp-bin/wsp"), args: ["mcp"] },
      },
      projects: { [home]: { mcpServers: { local: { command: "node", args: ["server.js"] } } } },
    }),
  );
  put(h(".codex/config.toml"), `model = "gpt-5"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/sse"\nhttp_headers = { Authorization = "Bearer ${SECRET}" }\n\n[mcp_servers.old]\ncommand = "uvx"\nargs = ["old-server"]\nenabled = false\n`);
  put(h(".gemini/settings.json"), JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@example/fs", `--token=${SECRET}`] } } }));
  put(h(".config/opencode/opencode.json"), JSON.stringify({ mcp: { ctx: { type: "remote", url: "https://ctx.example/mcp", enabled: false } } }));

  // Login files a reader may stat and never read.
  put(h(".codex/auth.json"), JSON.stringify({ tokens: { access_token: SECRET } }));
  put(h(".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
  put(h(".gemini/oauth_creds.json"), JSON.stringify({ access_token: SECRET }));

  // The project a workspace holds.
  put(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "project-db": { command: "npx", args: ["-y", "db-mcp"] } } }));
  put(join(project, ".claude/skills/deploy/SKILL.md"), skill("deploy", "Deploy the app"));
  put(join(project, ".agents/skills/lint/SKILL.md"), skill("lint", "Lint the app"));

  // Agents on the login's PATH, and the runners a server command would start, which say so if they ever run.
  const script = (name: string, body: string): void => {
    put(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("claude", `case "$1" in --version) echo "2.1.281 (Claude Code)";; auth) echo '{"loggedIn": true, "authMethod": "claude.ai"}';; *) exit 2;; esac`);
  script("codex", `case "$1" in --version) echo "codex-cli 0.155.1";; login) echo "Not logged in"; exit 1;; *) exit 2;; esac`);
  script("hermes", `case "$1" in --version) echo "Hermes Agent v0.20.0 (2026.8.3)";; auth) echo "openrouter (1 credentials):";; *) exit 2;; esac`);
  for (const runner of ["npx", "uvx", "node", "wsp"]) script(runner, `touch "$HOME/SPAWNED"; exit 0`);
  return { home, bin, project };
}
