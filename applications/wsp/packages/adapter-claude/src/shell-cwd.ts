// SPDX-License-Identifier: AGPL-3.0-only
// Where the agent's tool shell is, read from its tool calls. The CLI keeps
// one shell across Bash calls, so a cd at the head of a command moves every
// later call. A Write or Edit to an absolute path is a weaker hint: its folder
// is taken only under the harness's own folder, and never deeper inside the
// folder already followed, so a project's files do not walk the panes around.
// A path the shell would still expand is skipped. A cd that fails is stamped
// anyway: the tool result's error flag cannot tell it from a later failure.
import { posix } from "node:path";

const CD_HEAD = /^\s*cd\s+(?:"([^"$`]*)"|'([^']*)'|([^\s;&|$`*?[{~]+))\s*(?:$|&&|;|\|\||\n)/;
const PATH_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function absolute(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") ? posix.normalize(value).replace(/(.)\/$/, "$1") : undefined;
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

/** The shell's folder after this tool call when the call moves it, else undefined. */
export function shellCwdAfter(toolName: string | undefined, input: unknown, current: string, harnessCwd: string): string | undefined {
  const fields = rec(input);
  if (toolName === undefined || fields === undefined) return undefined;
  if (toolName === "Bash") {
    const match = CD_HEAD.exec(typeof fields.command === "string" ? fields.command : "");
    const target = absolute(match?.[1] ?? match?.[2] ?? match?.[3]);
    return target !== undefined && target !== current ? target : undefined;
  }
  if (!PATH_TOOLS.has(toolName)) return undefined;
  const file = absolute(fields.file_path);
  if (file === undefined) return undefined;
  const folder = posix.dirname(file);
  if (folder === harnessCwd || !within(folder, harnessCwd)) return undefined;
  if (current !== harnessCwd && within(folder, current)) return undefined;
  return folder;
}
