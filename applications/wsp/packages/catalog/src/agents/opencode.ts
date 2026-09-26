// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { OPENCODE_CONTEXT } from "../context.js";
import { OPENCODE_JSON } from "../mcp.js";
import { OPENCODE_MCP_LOGIN } from "../mcp-login.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS } from "../skills.js";
import { SIGN_IN_ROWS } from "../signin.js";
import { agent, dfSize } from "./entry.js";

export const OPENCODE: AgentEntry = {
  ...agent("opencode", dfSize(673)),
  stateHome: ".local/share/opencode",
  name: "OpenCode",
  about: { creator: "Anomaly", description: "The open source coding agent for the terminal.", homepage: "https://opencode.ai", repo: "https://github.com/anomalyco/opencode", license: "MIT" },
  mark: { source: "https://github.com/simple-icons/simple-icons/blob/develop/icons/opencode.svg", license: "CC0-1.0", svg: `<svg viewBox="0 0 24 24"><path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/></svg>` },
  context: OPENCODE_CONTEXT,
  // 1.18.18: its own folder, where it holds copies, then Claude Code's and the shared folder, which it loads too.
  skillRoots: {
    user: [{ dir: "~/.config/opencode/skills", lands: "copy" }, { dir: "~/.claude/skills", lands: "link" }, { dir: SHARED_SKILLS, lands: "copy" }],
    project: [{ dir: ".opencode/skills", lands: "copy" }, { dir: ".claude/skills", lands: "link" }, { dir: PROJECT_SHARED_SKILLS, lands: "copy" }],
  },
  installRoad: { road: "npm", package: "opencode-ai", version: "1.18.27" },
  latest: { from: "npm", package: "opencode-ai" },
  signIn: SIGN_IN_ROWS.opencode,
  // https://opencode.ai/docs/mcp-servers/ (project scope is a repo's opencode.json)
  mcp: { format: OPENCODE_JSON, files: ["~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc"], projectFiles: ["opencode.json", "opencode.jsonc"], scope: "user scope", login: OPENCODE_MCP_LOGIN },
  configPaths: [
    "~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc", "~/.config/opencode/AGENTS.md", "~/.config/opencode/package.json",
    "~/.config/opencode/agents", "~/.config/opencode/commands", "~/.config/opencode/plugins", "~/.config/opencode/skills", "~/.config/opencode/themes",
  ],
  projectState: [
    { state: "project", location: "opencode.db, table project", key: "id is the git root commit hash; \"global\" for folders outside git", pathFields: ["worktree", "sandboxes"], move: "update project set worktree, clear sandboxes", status: "measured" },
    { state: "project directories", location: "table project_directory", key: "(project_id, directory)", pathFields: ["directory"], move: "update the row", status: "measured" },
    { state: "sessions", location: "table session", key: "id ses_..., project_id", pathFields: ["directory"], move: "update session set directory", status: "measured" },
  ],
  source: { sessions: 0, images: 0, road: "measured" },
};
