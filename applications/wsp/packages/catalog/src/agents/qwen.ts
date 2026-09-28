// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { NO_SIGN_IN } from "../signin.js";
import { NOT_MEASURED, UNMEASURED, agent } from "./entry.js";

export const QWEN: AgentEntry = {
  ...agent("qwen", NOT_MEASURED),
  ...UNMEASURED,
  name: "Qwen Code",
  about: { creator: "Qwen team, Alibaba", description: "An open source coding agent for the terminal from the Qwen team.", homepage: "https://qwenlm.github.io/qwen-code-docs/en/users/overview", repo: "https://github.com/QwenLM/qwen-code", license: "Apache-2.0" },
  mark: { inks: [{ light: "#6d44e8", dark: "#8b6cf0" }], source: "https://github.com/QwenLM/qwen-code/blob/c3a4058a0c7207de7b421e9da0622a9ec890dbad/packages/vscode-ide-companion/assets/sidebar-icon.svg", license: "Apache-2.0", svg: `<svg viewBox="0 0 141.38 140"><path fill="currentColor" d="m140.93 85-16.35-28.33-1.93-3.34 8.66-15a3.323 3.323 0 0 0 0-3.34l-9.62-16.67c-.3-.51-.72-.93-1.22-1.22s-1.07-.45-1.67-.45H82.23l-8.66-15a3.33 3.33 0 0 0-2.89-1.67H51.43c-.59 0-1.17.16-1.66.45-.5.29-.92.71-1.22 1.22L32.19 29.98l-1.92 3.33H12.96c-.59 0-1.17.16-1.66.45-.5.29-.93.71-1.22 1.22L.45 51.66a3.323 3.323 0 0 0 0 3.34l18.28 31.67-8.66 15a3.32 3.32 0 0 0 0 3.34l9.62 16.67c.3.51.72.93 1.22 1.22s1.07.45 1.67.45h36.56l8.66 15a3.35 3.35 0 0 0 2.89 1.67h19.25a3.34 3.34 0 0 0 2.89-1.67l18.28-31.67h17.32c.6 0 1.17-.16 1.67-.45s.92-.71 1.22-1.22l9.62-16.67a3.323 3.323 0 0 0 0-3.34ZM51.44 3.33 61.07 20l-9.63 16.66h76.98l-9.62 16.66H45.67l-11.54-20zM57.21 120H22.58l9.63-16.67h19.25l-38.5-66.67h19.25l9.62 16.67L68.78 100l-11.55 20Zm61.59-33.34-9.62-16.67-38.49 66.67-9.63-16.67 9.63-16.66 26.94-46.67h23.1l17.32 30z"/></svg>` },
  stateHome: ".qwen",
  // Its skills docs as of 0.24.5: one folder for the person, one in the project.
  skillRoots: { user: [{ dir: "~/.qwen/skills", lands: "copy" }], project: [{ dir: ".qwen/skills", lands: "copy" }] },
  // The package runs no script of its own; its dependencies ship prebuilt per platform.
  installRoad: { road: "npm", package: "@qwen-code/qwen-code", version: "0.24.5", ignoreScripts: true },
  latest: { from: "npm", package: "@qwen-code/qwen-code" },
  node: 22,
  signIn: NO_SIGN_IN,
};
