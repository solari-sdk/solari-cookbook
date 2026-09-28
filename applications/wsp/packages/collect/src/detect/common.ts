// SPDX-License-Identifier: AGPL-3.0-only
import { type Host, expand } from "../host.js";
import type { Default, Linux, ManifestEntry, Rung } from "../manifest.js";

/** prior is every row the rungs before this one produced. */
export type Detector = (host: Host, prior: readonly ManifestEntry[]) => Promise<ManifestEntry[]>;

export interface RowSpec {
  rung: Rung;
  id: string;
  label: string;
  /** `~/`-relative candidates; only the ones that exist end up on the row. */
  paths: readonly string[];
  default?: Default;
  reason?: string;
  group?: string;
  required?: boolean;
  linux?: Linux;
  version?: string;
  arch?: string;
  /** Candidates the tool rewrites while it runs; those found land on the row as volatile. */
  volatile?: readonly string[];
  /** Emit the row even when none of the candidate paths exist. */
  always?: boolean;
  /** One line for the detail pane. */
  detail?: string;
}

export interface Found {
  paths: string[];
  bytes: number;
}

/** The subset of candidates that exist, with their total size. */
export async function found(host: Host, paths: readonly string[]): Promise<Found> {
  const out: Found = { paths: [], bytes: 0 };
  for (const p of paths) {
    const s = await host.fs.stat(expand(host, p));
    if (s === undefined) continue;
    out.paths.push(p);
    out.bytes += s.bytes;
  }
  return out;
}

export async function exists(host: Host, path: string): Promise<boolean> {
  return (await host.fs.stat(expand(host, path))) !== undefined;
}

/** One manifest row for whichever of the spec's paths exist; undefined when none do. */
export async function row(host: Host, spec: RowSpec): Promise<ManifestEntry | undefined> {
  const f = await found(host, spec.paths);
  if (f.paths.length === 0 && spec.always !== true) return undefined;
  return entry({ ...spec, ...f });
}

export interface EntrySpec extends Omit<RowSpec, "paths" | "always"> {
  paths: string[];
  bytes: number;
}

/** Optional fields are left off rather than set to undefined so equality and snapshots stay exact. */
export function entry(spec: EntrySpec): ManifestEntry {
  const volatile = (spec.volatile ?? []).filter(p => spec.paths.includes(p));
  return {
    rung: spec.rung,
    id: spec.id,
    label: spec.label,
    ...(spec.group !== undefined ? { group: spec.group } : {}),
    paths: spec.paths,
    bytes: spec.bytes,
    default: spec.default ?? "bring",
    ...(spec.reason !== undefined ? { reason: spec.reason } : {}),
    ...(spec.required !== undefined ? { required: spec.required } : {}),
    ...(spec.linux !== undefined ? { linux: spec.linux } : {}),
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    ...(spec.arch !== undefined ? { arch: spec.arch } : {}),
    ...(volatile.length > 0 ? { volatile } : {}),
    ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
  };
}

/** A list item (a formula, an extension, a global package): no source path, nothing to upload. */
export function item(spec: Omit<EntrySpec, "paths" | "bytes">): ManifestEntry {
  return entry({ ...spec, paths: [], bytes: 0 });
}

export function present(rows: (ManifestEntry | undefined)[]): ManifestEntry[] {
  return rows.filter((r): r is ManifestEntry => r !== undefined);
}

export function firstLine(out: string | undefined): string | undefined {
  const line = out?.split("\n")[0]?.trim();
  return line === undefined || line === "" ? undefined : line;
}
