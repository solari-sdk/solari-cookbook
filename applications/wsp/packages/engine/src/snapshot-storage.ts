// SPDX-License-Identifier: AGPL-3.0-only
// Snapshot storage as the provider bills it, and which of a golden's versions
// retention may offer to delete.
import { goldenHead, type GoldenManifest, type GoldenVersion, type SnapshotStorage } from "@wsp/protocol";
import type { SnapshotRow, SnapshotStoragePricing } from "./machine.js";
import { OWN_GRACE_MS } from "./orphans.js";
import { nameOwner } from "./snapshot-names.js";

/** The provider quotes decimal GB: a 3839352227-byte snapshot lists as 3.84 GB. */
const GB = 1e9;

export function snapshotMonthlyUsd(totalBytes: number, pricing: SnapshotStoragePricing): number {
  return Math.max(0, totalBytes / GB - pricing.freeGb) * pricing.usdPerGbMonth;
}

/** Anything the provider lists that wsp may have made: a snapshot or a template. */
export interface OwnedRow {
  id: string;
  name?: string;
  createdAt?: string;
}

/** kept: a golden version, a project golden or a live workspace names this id, so it is in use whatever its name
 * says; or this host marked it inside the grace below, before the road that records it got there. orphan: this
 * host's mark on the name, past the grace, and nothing names the id, which is what a rebuild the doctor lost or an
 * init whose state file was replaced leaves behind. foreign: no mark of this host, so another host or a person
 * made it and nothing here ever deletes it. */
export type Ownership = "kept" | "orphan" | "foreign";

/** What the split reads a row against: this host's mark, the ids anything records, and the clock the grace is
 * measured on. */
export interface OwnerRead {
  hostId: string;
  recorded: ReadonlySet<string>;
  now: number;
}

/** The same window a machine gets before the sweep may claim it (OWN_GRACE_MS), for the same reason: a seal takes
 * its snapshot minutes before the manifest records it (kill, promote, smoke fork), and a project golden's document
 * is written after its checkpoint returns. A row whose age cannot be proven past that window keeps its place, so a
 * provider that gave no readable stamp never costs a snapshot: a delete cannot be undone, where the reaper's own
 * unknown-age machine costs an hourly bill instead. */
function youngerThanGrace(createdAt: string | undefined, now: number): boolean {
  const at = Date.parse(createdAt ?? "");
  return Number.isNaN(at) || now - at < OWN_GRACE_MS;
}

export function ownershipOf(row: OwnedRow, read: OwnerRead): Ownership {
  if (read.recorded.has(row.id)) return "kept";
  if (nameOwner(row.name) !== read.hostId) return "foreign";
  return youngerThanGrace(row.createdAt, read.now) ? "kept" : "orphan";
}

export interface OwnerSplit<T> {
  kept: T[];
  orphans: T[];
  foreign: T[];
}

/** The one split, over snapshots and over templates alike: who made each row, whether anything records it, and
 * whether it is old enough that nothing was still on its way to recording it. */
export function splitByOwner<T extends OwnedRow>(rows: readonly T[], read: OwnerRead): OwnerSplit<T> {
  if (read.hostId === "") throw new Error("the snapshot split needs this host's mark; without one it could not tell this host's snapshots from another host's");
  const split: OwnerSplit<T> = { kept: [], orphans: [], foreign: [] };
  for (const row of rows) {
    const where = ownershipOf(row, read);
    (where === "kept" ? split.kept : where === "orphan" ? split.orphans : split.foreign).push(row);
  }
  return split;
}

const group = (rows: readonly SnapshotRow[]): { count: number; bytes: number } => ({ count: rows.length, bytes: rows.reduce((n, r) => n + r.sizeBytes, 0) });

export function snapshotStorage(rows: readonly SnapshotRow[], pricing: SnapshotStoragePricing, read: OwnerRead): SnapshotStorage {
  const totalBytes = rows.reduce((n, r) => n + r.sizeBytes, 0);
  const split = splitByOwner(rows, read);
  return {
    count: rows.length,
    totalBytes,
    freeGb: pricing.freeGb,
    usdPerGbMonth: pricing.usdPerGbMonth,
    billedFrom: pricing.billedFrom,
    monthlyUsd: snapshotMonthlyUsd(totalBytes, pricing),
    kept: group(split.kept),
    orphans: group(split.orphans),
    others: group(split.foreign),
  };
}

/** Versions the head and its parent, so a rollback has one step back. */
export const RETENTION_KEEP = 2;

export interface RetentionPlan {
  /** The head and the ancestors under it that stay, newest first. */
  keep: GoldenVersion[];
  /** What the offer deletes: older ancestors oldest first, then the abandoned branches by version. */
  drop: GoldenVersion[];
  /** The members of drop that sit off the head's chain and behind it: nothing kept was built through them. */
  abandoned: GoldenVersion[];
  /** Versions a workspace was forked from; each stays while that workspace exists. */
  guarded: { version: GoldenVersion; workspaces: string[] }[];
  /** The kept parent was taken as the next version down: the head was sealed before parents were recorded. */
  parentAssumed: boolean;
  /** What the listing says the dropped snapshots hold; a snapshot the listing lacks counts as nothing. */
  freedBytes: number;
  /** The monthly cost now minus the cost once they are gone, so a drop inside the free GB saves nothing. */
  savesUsdPerMonth: number;
}

/** The chain of ancestors from the head: each version's recorded parent, or for a version sealed before parents
 * were recorded the next version down. Versions off the chain and behind the head are abandoned branches: nothing
 * kept was built through them, so they are offered too, behind the same lineage guard. Versions ahead of the head
 * (right after a rollback, before an update seals past them) may still be rolled forward to and are left alone. */
export function retentionPlan(
  manifest: GoldenManifest,
  rows: readonly SnapshotRow[],
  forkedFrom: (snapshotId: string) => string[],
  pricing: SnapshotStoragePricing,
  keepCount = RETENTION_KEEP,
): RetentionPlan {
  const head = goldenHead(manifest);
  const bySnapshot = new Map(manifest.versions.map(v => [v.snapshotId, v]));
  const parentOf = (v: GoldenVersion): { parent: GoldenVersion | undefined; assumed: boolean } => {
    if (v.parentSnapshotId !== undefined) return { parent: bySnapshot.get(v.parentSnapshotId), assumed: false };
    const below = manifest.versions.filter(x => x.version < v.version).sort((a, b) => b.version - a.version);
    return { parent: below[0], assumed: below.length > 0 };
  };
  const chain: GoldenVersion[] = head === undefined ? [] : [head];
  let parentAssumed = false;
  for (let cur = head; cur !== undefined; ) {
    const { parent, assumed } = parentOf(cur);
    if (parent === undefined || chain.includes(parent)) break;
    if (chain.length === 1) parentAssumed = assumed;
    chain.push(parent);
    cur = parent;
  }
  const keep = chain.slice(0, keepCount);
  const older = chain.slice(keepCount).reverse();
  const offChain = head === undefined ? [] : manifest.versions.filter(v => v.version < head.version && !chain.includes(v)).sort((a, b) => a.version - b.version);
  const drop: GoldenVersion[] = [];
  const abandoned: GoldenVersion[] = [];
  const guarded: RetentionPlan["guarded"] = [];
  for (const version of [...older, ...offChain]) {
    const workspaces = forkedFrom(version.snapshotId);
    if (workspaces.length > 0) {
      guarded.push({ version, workspaces });
      continue;
    }
    drop.push(version);
    if (offChain.includes(version)) abandoned.push(version);
  }
  const sizeOf = (id: string): number => rows.find(r => r.id === id)?.sizeBytes ?? 0;
  const totalBytes = rows.reduce((n, r) => n + r.sizeBytes, 0);
  const freedBytes = drop.reduce((n, v) => n + sizeOf(v.snapshotId), 0);
  return { keep, drop, abandoned, guarded, parentAssumed, freedBytes, savesUsdPerMonth: snapshotMonthlyUsd(totalBytes, pricing) - snapshotMonthlyUsd(totalBytes - freedBytes, pricing) };
}
