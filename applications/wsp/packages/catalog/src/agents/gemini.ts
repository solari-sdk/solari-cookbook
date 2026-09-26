// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentEntry } from "../catalog.js";
import { GEMINI_CONTEXT } from "../context.js";
import { GEMINI_MCP_LOGIN } from "../mcp-login.js";
import { GEMINI_SETTINGS_JSON } from "../mcp.js";
import { SIGN_IN_ROWS } from "../signin.js";
import { agent, dfSize } from "./entry.js";

export const GEMINI: AgentEntry = {
  ...agent("gemini", dfSize(189)),
  stateHome: ".gemini",
  name: "Gemini CLI",
  about: { creator: "Google", description: "An open source agent that brings Gemini into the terminal.", homepage: "https://geminicli.com", repo: "https://github.com/google-gemini/gemini-cli", license: "Apache-2.0" },
  mark: { source: "https://github.com/lobehub/lobe-icons/blob/329f378cbd1a88f45b60cd096b9111ce16f3ea39/src/Gemini/components/Color.tsx", license: "MIT", svg: `<svg viewBox="0 0 24 24"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#a)"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#b)"/><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#c)"/><defs><linearGradient gradientUnits="userSpaceOnUse" id="a" x1="7" x2="11" y1="15.5" y2="12"><stop stop-color="#08B962"/><stop offset="1" stop-color="#08B962" stop-opacity="0"/></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="b" x1="8" x2="11.5" y1="5.5" y2="11"><stop stop-color="#F94543"/><stop offset="1" stop-color="#F94543" stop-opacity="0"/></linearGradient><linearGradient gradientUnits="userSpaceOnUse" id="c" x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stop-color="#FABC12"/><stop offset=".46" stop-color="#FABC12" stop-opacity="0"/></linearGradient></defs></svg>` },
  context: GEMINI_CONTEXT,
  // Its docs as of 0.58.0 (no Gemini on the Mac measured); copies found there.
  skillRoots: { user: [{ dir: "~/.gemini/skills", lands: "copy" }], project: [{ dir: ".gemini/skills", lands: "copy" }] },
  installRoad: { road: "npm", package: "@google/gemini-cli", version: "0.58.0" },
  latest: { from: "npm", package: "@google/gemini-cli" },
  node: 20,
  signIn: SIGN_IN_ROWS.gemini,
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md (project scope is a repo's .gemini/settings.json)
  mcp: { format: GEMINI_SETTINGS_JSON, files: ["~/.gemini/settings.json"], projectFiles: [".gemini/settings.json"], scope: "user scope", login: GEMINI_MCP_LOGIN },
  configPaths: ["~/.gemini/settings.json", "~/.gemini/GEMINI.md", "~/.gemini/commands"],
  projectState: [
    { state: "project registry", location: "projects.json", key: "{\"projects\": {\"PATH\": \"SLUG\"}}; SLUG is the folder basename, deduplicated", pathFields: ["the key"], move: "rewrite the key, keep the slug", status: "measured" },
    { state: "project temp dir", location: "tmp/SLUG/ with chats/, logs/ and .project_root", key: "the slug from the registry", pathFields: [".project_root"], move: "rewrite .project_root", status: "measured" },
    { state: "shell history", location: "history/SLUG/ with .project_root", key: "the same slug", pathFields: [".project_root"], move: "rewrite .project_root", status: "measured" },
    { state: "chat files", location: "tmp/SLUG/chats/session-TIMESTAMP-ID8.jsonl", key: "by slug directory", pathFields: ["projectHash in the header line, the sha256 hex of the resolved path", "the workspace path as text in the first user message"], move: "optional; neither listing nor resume checks it", status: "measured" },
    { state: "trust", location: "trustedFolders.json", key: "the resolved path to a trust level", pathFields: ["the key"], move: "rewrite the key", status: "inferred" },
  ],
  source: { sessions: 0, images: 0, road: "measured" },
};
