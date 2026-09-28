// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { pinnedRelease } from "../release-pins.js";
import { NO_SIGN_IN } from "../signin.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS, XDG_SHARED_SKILLS } from "../skills.js";
import { UNMEASURED, agent } from "./entry.js";

// Its npm package downloads this same release in a postinstall script, so the road takes the release and its sum.
export const CRUSH: AgentEntry = {
  // The binary the x86_64 asset unpacks to.
  ...agent("crush", { bytes: 86818976, on: "2026-09-26", method: "unpacked" }),
  ...UNMEASURED,
  name: "Crush",
  about: { creator: "Charm", description: "Charm's coding agent for the terminal. It works with the model of your choice and your own servers, language servers and skills.", homepage: "https://charm.sh/crush", repo: "https://github.com/charmbracelet/crush", license: "FSL-1.1-MIT" },
  stateHome: ".local/share/crush",
  // Its README, read 2026-09-26: its own folder, the XDG agents folder, the shared folder, and Claude Code's and Cursor's in a project.
  skillRoots: {
    user: [{ dir: "~/.config/crush/skills", lands: "copy" }, { dir: XDG_SHARED_SKILLS, lands: "copy" }, { dir: SHARED_SKILLS, lands: "copy" }, { dir: "~/.claude/skills", lands: "link" }],
    project: [{ dir: ".crush/skills", lands: "copy" }, { dir: PROJECT_SHARED_SKILLS, lands: "copy" }, { dir: ".claude/skills", lands: "link" }, { dir: ".cursor/skills", lands: "copy" }],
  },
  installRoad: pinnedRelease("charmbracelet/crush"),
  latest: { from: "github", repo: "charmbracelet/crush" },
  signIn: NO_SIGN_IN,
};
