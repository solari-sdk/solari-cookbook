// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { PI_CONTEXT } from "../context.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS } from "../skills.js";
import { SIGN_IN_ROWS } from "../signin.js";
import { agent, dfSize } from "./entry.js";

export const PI: AgentEntry = {
  ...agent("pi", dfSize(165)),
  stateHome: ".pi/agent",
  name: "Pi",
  about: { creator: "Earendil Works", description: "A small coding agent for the terminal with read, bash, edit and write tools and saved sessions.", repo: "https://github.com/earendil-works/pi", license: "MIT" },
  mark: { inks: [{ light: "#c76b5e", dark: "#f09082" }, { light: "#408eb2", dark: "#4d9abf" }, { light: "#b07f00", dark: "#f1be58" }], source: "https://pi.dev/logo.svg (etag 83ce9b96de956e389a65386b733922a1, read 2026-09-25)", license: "MIT", svg: `<svg viewBox="0 0 800 800"><path d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path fill="var(--ink-1)" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path fill="var(--ink-2)" d="M517.36 400H634.72V634.72H517.36Z"/></svg>` },
  context: PI_CONTEXT,
  // 0.84.1: its own folder, links into the shared folder there, and the shared folder.
  skillRoots: { user: [{ dir: "~/.pi/agent/skills", lands: "link" }, { dir: SHARED_SKILLS, lands: "copy" }], project: [{ dir: ".pi/skills", lands: "copy" }, { dir: PROJECT_SHARED_SKILLS, lands: "copy" }] },
  installRoad: { road: "npm", package: "@earendil-works/pi-coding-agent", version: "0.84.4", ignoreScripts: true },
  latest: { from: "npm", package: "@earendil-works/pi-coding-agent" },
  node: 22,
  signIn: SIGN_IN_ROWS.pi,
  // models.json stays: a provider entry may carry a literal apiKey. trust.json stays: it keys on this laptop's absolute project paths.
  configPaths: [
    "~/.pi/agent/settings.json", "~/.pi/agent/keybindings.json", "~/.pi/agent/AGENTS.md", "~/.pi/agent/SYSTEM.md", "~/.pi/agent/APPEND_SYSTEM.md",
    "~/.pi/agent/prompts", "~/.pi/agent/skills", "~/.pi/agent/extensions", "~/.pi/agent/themes",
  ],
  projectState: [
    { state: "sessions", location: "sessions/KEY/TIMESTAMP_SESSIONID.jsonl", key: "two dashes, the resolved path without its leading slash with every slash, backslash and colon replaced by a dash, two dashes; dots and underscores kept", pathFields: ["cwd in the header line"], move: "rename the KEY directory; rewriting cwd is optional", status: "measured" },
    { state: "trust", location: "trust.json", key: "the resolved path to true; a parent folder covers its children", pathFields: ["the key"], move: "rewrite the key", status: "inferred" },
  ],
  source: { sessions: 0, images: 0, road: "measured" },
};
