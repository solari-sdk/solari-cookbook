// SPDX-License-Identifier: AGPL-3.0-only
// The files that pin a toolchain by name and version for whoever opens the
// repo: asdf's .tool-versions, one name and its versions per line, and mise's
// [tools] table. Both say the same thing in two syntaxes, so one module reads
// them into the same pair.
import type { ProjectFinding, ProjectReader } from "../reader.js";

interface Pin {
  name: string;
  version?: string;
}

/** `golang 1.24.0 1.23.5` to golang at 1.24.0; a comment or a blank line to nothing. */
function toolVersionsPins(text: string): Pin[] {
  return text.split("\n").flatMap((line): Pin[] => {
    const [name, version] = line.replace(/#.*$/, "").trim().split(/\s+/);
    if (name === undefined || name === "") return [];
    return [{ name, ...(version !== undefined ? { version } : {}) }];
  });
}

const QUOTED = /^["']|["']$/g;
/** The `[tools]` table's keys with the first version each names; a value that is a table or a list gives the first string in it. */
function miseTomlPins(text: string): Pin[] {
  const out: Pin[] = [];
  let inTools = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim().replace(QUOTED, "");
    if (name === "") continue;
    const version = /["']([^"']+)["']/.exec(line.slice(eq + 1))?.[1];
    out.push({ name, ...(version !== undefined ? { version } : {}) });
  }
  return out;
}

export const toolchainPinsReader: ProjectReader = {
  id: "toolchain-pins",
  files: [".tool-versions", "mise.toml", ".mise.toml"],
  reads: "text",
  read(file): readonly ProjectFinding[] {
    const pins = file.path === ".tool-versions" ? toolVersionsPins(file.text) : miseTomlPins(file.text);
    return pins.map(p => ({ name: p.name, label: p.name, why: `${file.path} names ${p.name}${p.version === undefined ? "" : ` ${p.version}`}` }));
  },
};
