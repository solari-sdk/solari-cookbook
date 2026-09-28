// SPDX-License-Identifier: AGPL-3.0-only
// What one project folder's own files say it needs. Histories say what the
// person used anywhere; a repo's manifests say what this repo takes to build.
// Every reader hands back words; naming the catalog row a word lands on
// happens once, here, so a reader never learns the catalog.
import { catalogToolFor, catalogToolForDependency } from "@wsp/catalog";
import type { Host } from "../host.js";
import type { ProjectFile, ProjectReader } from "./reader.js";
import { markerReader } from "./readers/marker.js";
import { packageJsonReader } from "./readers/package-json.js";
import { toolchainPinsReader } from "./readers/toolchain-pins.js";
import { workflowsReader } from "./readers/workflows.js";

/** The readers in the order their files speak plainest, from a pinned name and version to a file that only implies a
 * tool: the first one to name a tool writes the line that tool's row shows. */
export const PROJECT_READERS: readonly ProjectReader[] = [packageJsonReader, toolchainPinsReader, markerReader, workflowsReader];

/** One tool a project asks for, on the row it lands on. */
export interface ProjectNeed {
  /** The catalog id when the catalog carries the tool, else the word the project's own file used. */
  id: string;
  /** The catalog's name for it, else the word as its own ecosystem writes it. */
  name: string;
  /** Which file asked and what it said. */
  why: string;
}

export interface ProjectScan {
  /** The folder that was read. */
  dir: string;
  /** Needs the catalog carries, by catalog id: these are the rows a recipe ticks. */
  rows: ProjectNeed[];
  /** Needs the catalog has no row for, each a candidate for a custom row. */
  candidates: ProjectNeed[];
}

/** The paths one entry of a reader's list stands for: every file directly under a folder named with a trailing
 * slash, the same file in every folder under a `*` segment, else the entry itself. */
async function pathsOf(host: Host, dir: string, entry: string): Promise<string[]> {
  if (entry.endsWith("/")) return (await host.fs.list(`${dir}/${entry.slice(0, -1)}`)).map(name => `${entry}${name}`);
  const star = entry.indexOf("/*/");
  if (star < 0) return [entry];
  const head = entry.slice(0, star);
  return (await host.fs.list(`${dir}/${head}`)).map(name => `${head}/${name}${entry.slice(star + 2)}`);
}

/** The files under `dir` a reader asked for that are there, in the order it asked; a reader that reads nothing out
 * of them is told they are there and handed no bytes. */
async function filesFor(host: Host, dir: string, reader: ProjectReader): Promise<ProjectFile[]> {
  const out: ProjectFile[] = [];
  for (const entry of reader.files) {
    for (const path of await pathsOf(host, dir, entry)) {
      const at = `${dir}/${path}`;
      if (reader.reads === "presence") {
        if ((await host.fs.stat(at))?.kind === "file") out.push({ path, text: "" });
        continue;
      }
      const text = await host.fs.readText(at);
      if (text !== undefined) out.push({ path, text });
    }
  }
  return out;
}

/** Every reader over one project folder, its findings named against the catalog. What a why line carries is what the
 * repo's own manifests name a tool with: a tool's name, a pinned version, a version range, the manifest's own file
 * name. No other value of a file is read, and a credential never is; the recipe this writes into stays on this
 * computer, which is not the promise the collector's other readers make about a machine. */
export async function scanProject(host: Host, folder: string): Promise<ProjectScan> {
  const dir = folder.replace(/\/+$/, "");
  const rows = new Map<string, ProjectNeed>();
  const candidates = new Map<string, ProjectNeed>();
  for (const reader of PROJECT_READERS) {
    for (const file of await filesFor(host, dir, reader)) {
      for (const finding of reader.read(file)) {
        const entry = finding.installs !== undefined ? catalogToolForDependency(finding.installs, finding.name) : catalogToolFor(finding.name);
        if (entry !== undefined) {
          if (!rows.has(entry.id)) rows.set(entry.id, { id: entry.id, name: entry.name, why: finding.why });
          continue;
        }
        if (finding.catalogOnly === true) continue;
        if (!candidates.has(finding.name)) candidates.set(finding.name, { id: finding.name, name: finding.label, why: finding.why });
      }
    }
  }
  return { dir, rows: [...rows.values()], candidates: [...candidates.values()] };
}
