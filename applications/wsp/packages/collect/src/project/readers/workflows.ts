// SPDX-License-Identifier: AGPL-3.0-only
// GitHub Actions workflows: what CI installs before it builds the repo. A
// setup action names its toolchain; a run step's words name programs the same
// way a shell line anywhere does, so they count only where the catalog carries
// them.
import { commandNames } from "../../history/commands.js";
import type { ProjectFinding, ProjectReader } from "../reader.js";

export const WORKFLOWS_DIR = ".github/workflows/";

/** `actions/setup-go@v5` to go, `pnpm/action-setup@v4` to pnpm; any other action to nothing. A word ending in
 * `-action` is the owner's own action for one of its features (`docker/setup-buildx-action`), so the owner is the
 * tool: buildx is not something a machine installs, Docker is. */
const SETUP = /^\s*-?\s*uses:\s*["']?[\w.-]+\/(?:setup-([\w.-]+)|(?:([\w.-]+)\/)?action-setup)/;
const USES_OWNER = /^\s*-?\s*uses:\s*["']?([\w.-]+)\//;
const OWNS_IT = /-action$/;
const RUN = /^(\s*)-?\s*run:\s*(.*)$/;

/** Every step's shell text: an inline `run:`, or the block a `run: |` opens, which runs to the first line no deeper than the key. */
function runBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = RUN.exec(lines[i]!);
    if (m === null) continue;
    const rest = m[2]!.trim();
    if (rest !== "" && rest !== "|" && rest !== ">" && rest !== "|-" && rest !== ">-") {
      out.push(rest);
      continue;
    }
    const indent = m[1]!.length;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
      block.push(line.trim());
      i = j;
    }
    out.push(block.join("\n"));
  }
  return out;
}

export const workflowsReader: ProjectReader = {
  id: "workflows",
  files: [WORKFLOWS_DIR],
  reads: "text",
  read(file): readonly ProjectFinding[] {
    const lines = file.text.split("\n");
    const out: ProjectFinding[] = [];
    for (const line of lines) {
      const m = SETUP.exec(line);
      if (m === null) continue;
      const captured = m[1];
      const owner = USES_OWNER.exec(line)?.[1];
      const name = captured !== undefined && !OWNS_IT.test(captured) ? captured : (m[2] ?? owner);
      if (name === undefined || name === "") continue;
      out.push({ name, label: name, why: `${file.path} sets up ${name}` });
    }
    for (const block of runBlocks(lines)) {
      for (const name of commandNames(block)) out.push({ name, label: name, why: `${file.path} runs ${name}`, catalogOnly: true });
    }
    return out;
  },
};
