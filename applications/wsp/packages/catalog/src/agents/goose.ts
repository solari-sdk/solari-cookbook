// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { pinnedRelease } from "../release-pins.js";
import { NO_SIGN_IN } from "../signin.js";
import { PROJECT_SHARED_SKILLS, SHARED_SKILLS, XDG_SHARED_SKILLS } from "../skills.js";
import { UNMEASURED, agent } from "./entry.js";

export const GOOSE: AgentEntry = {
  // The binary the x86_64 asset unpacks to.
  ...agent("goose", { bytes: 300841352, on: "2026-09-26", method: "unpacked" }),
  ...UNMEASURED,
  name: "Goose",
  about: { creator: "Block", description: "An open source, extensible agent that installs, runs, edits and tests code with any model.", homepage: "https://goose-docs.ai", repo: "https://github.com/aaif-goose/goose", license: "Apache-2.0" },
  mark: { source: "https://github.com/lobehub/lobe-icons/blob/329f378cbd1a88f45b60cd096b9111ce16f3ea39/src/Goose/components/Mono.tsx", license: "MIT", svg: `<svg viewBox="0 0 24 24"><g fill-rule="evenodd"><path d="M21.595 23.61c1.167-.254 2.405-.944 2.405-.944l-2.167-1.784a12.124 12.124 0 01-2.695-3.131 12.127 12.127 0 00-3.97-4.049l-.794-.462a1.115 1.115 0 01-.488-.815.844.844 0 01.154-.575c.413-.582 2.548-3.115 2.94-3.44.503-.416 1.065-.762 1.586-1.159.074-.056.148-.112.221-.17.003-.002.007-.004.009-.007.167-.131.325-.272.45-.438.453-.524.563-.988.59-1.193-.061-.197-.244-.639-.753-1.148.319.02.705.272 1.056.569.235-.376.481-.773.727-1.171.165-.266-.08-.465-.086-.471h-.001V3.22c-.007-.007-.206-.25-.471-.086-.567.35-1.134.702-1.639 1.021 0 0-.597-.012-1.305.599a2.464 2.464 0 00-.438.45l-.007.009c-.058.072-.114.147-.17.221-.397.521-.743 1.083-1.16 1.587-.323.391-2.857 2.526-3.44 2.94a.842.842 0 01-.574.153 1.115 1.115 0 01-.815-.488l-.462-.794a12.123 12.123 0 00-4.049-3.97 12.133 12.133 0 01-3.13-2.695L1.332 0S.643 1.238.39 2.405c.352.428 1.27 1.49 2.34 2.302C1.58 4.167.73 3.75.06 3.4c-.103.765-.063 1.92.043 2.816.726.317 1.961.806 3.219 1.066-1.006.236-2.11.278-2.961.262.15.554.358 1.119.64 1.688.119.263.25.52.39.77.452.125 2.222.383 3.164.171l-2.51.897a27.776 27.776 0 002.544 2.726c2.031-1.092 2.494-1.241 4.018-2.238-2.467 2.008-3.108 2.828-3.8 3.67l-.483.678c-.25.351-.469.725-.65 1.117-.61 1.31-1.47 4.1-1.47 4.1-.154.486.202.842.674.674 0 0 2.79-.861 4.1-1.47.392-.182.766-.4 1.118-.65l.677-.483c.227-.187.453-.37.701-.586 0 0 1.705 2.02 3.458 3.349l.896-2.511c-.211.942.046 2.712.17 3.163.252.142.509.272.772.392.569.28 1.134.49 1.688.64-.016-.853.026-1.956.261-2.962.26 1.258.75 2.493 1.067 3.219.895.106 2.051.146 2.816.043a73.87 73.87 0 01-1.308-2.67c.811 1.07 1.874 1.988 2.302 2.34h-.001z"/></g></svg>` },
  stateHome: ".local/share/goose",
  // Its skills module at v1.52.0: its own config folder, the shared folder, Claude Code's and the XDG agents folder.
  skillRoots: {
    user: [{ dir: "~/.config/goose/skills", lands: "copy" }, { dir: SHARED_SKILLS, lands: "copy" }, { dir: "~/.claude/skills", lands: "link" }, { dir: XDG_SHARED_SKILLS, lands: "copy" }],
    project: [{ dir: ".goose/skills", lands: "copy" }, { dir: PROJECT_SHARED_SKILLS, lands: "copy" }, { dir: ".claude/skills", lands: "link" }],
  },
  installRoad: pinnedRelease("aaif-goose/goose"),
  latest: { from: "github", repo: "aaif-goose/goose" },
  signIn: NO_SIGN_IN,
};
