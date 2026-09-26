// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { NO_SIGN_IN } from "../signin.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS, XDG_SHARED_SKILLS } from "../skills.js";
import { NOT_MEASURED, UNMEASURED, agent } from "./entry.js";

export const AMP: AgentEntry = {
  ...agent("amp", NOT_MEASURED),
  ...UNMEASURED,
  name: "Amp",
  about: { creator: "Sourcegraph", description: "The command line for Amp, a coding agent and development environment.", homepage: "https://ampcode.com", license: "proprietary" },
  mark: { source: "https://github.com/lobehub/lobe-icons/blob/329f378cbd1a88f45b60cd096b9111ce16f3ea39/src/Amp/components/Color.tsx", license: "MIT", svg: `<svg viewBox="0 0 24 24"><path d="M15.087 23.18L12.03 24l-2.097-7.823-5.738 5.738-2.251-2.251 5.718-5.719-7.769-2.082.82-3.057 11.294 3.08 3.08 11.295z" fill="#F34E3F"/><path d="M19.505 18.762l-3.057.82-2.564-9.573-9.572-2.564.819-3.057 11.295 3.079 3.08 11.295z" fill="#F34E3F"/><path d="M23.893 14.374l-3.057.82-2.565-9.572L8.7 3.057 9.52 0l11.295 3.08 3.079 11.294z" fill="#F34E3F"/></svg>` },
  stateHome: ".config/amp",
  // The folders its skills docs name; its own comes first by the shared-folder rule in skills.ts.
  skillRoots: {
    user: [{ dir: "~/.config/amp/skills", lands: "copy" }, { dir: XDG_SHARED_SKILLS, lands: "copy" }, { dir: SHARED_SKILLS, lands: "copy" }, { dir: "~/.claude/skills", lands: "link" }],
    project: [{ dir: PROJECT_SHARED_SKILLS, lands: "copy" }, { dir: ".claude/skills", lands: "link" }],
  },
  // Its postinstall links the binary out of the platform package npm already fetched; it downloads nothing.
  installRoad: { road: "npm", package: "@ampcode/cli", version: "0.0.1790352060-g26b83c" },
  latest: { from: "npm", package: "@ampcode/cli" },
  signIn: NO_SIGN_IN,
};
