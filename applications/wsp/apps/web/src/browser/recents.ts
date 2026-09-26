// SPDX-License-Identifier: AGPL-3.0-only
// Recently framed servers, one list per workspace in local storage. Entries
// key off the loopback form of a server, never the minted route: the route's
// token rotates hourly and the hostname belongs to the machine of the day.
// Shape hand-written from t3code browserHistoryStore.ts BrowserHistoryEntry
// (commit 57a66608).
import { useLocalStorage, type Codec } from "../hooks/useLocalStorage.js";

export interface BrowserHistoryEntry {
  readonly url: string;
  readonly lastVisitedAt: number;
  readonly title?: string;
}

export const RECENTS_MAX = 50;

export const recentsKey = (workspaceId: string): string => `wsp:browser-recents:v1:${workspaceId}`;

const EMPTY: BrowserHistoryEntry[] = [];

const codec: Codec<BrowserHistoryEntry[]> = {
  decode: raw => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    return parsed.filter(isEntry);
  },
  encode: value => JSON.stringify(value),
};

function isEntry(value: unknown): value is BrowserHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const { url, lastVisitedAt, title } = value as Record<string, unknown>;
  return (
    typeof url === "string" &&
    typeof lastVisitedAt === "number" &&
    Number.isFinite(lastVisitedAt) &&
    (title === undefined || typeof title === "string")
  );
}

export function recordVisit(entries: ReadonlyArray<BrowserHistoryEntry>, url: string, at: number): BrowserHistoryEntry[] {
  const existing = entries.find(e => e.url === url);
  const rest = entries.filter(e => e.url !== url);
  const entry: BrowserHistoryEntry = existing ? { ...existing, lastVisitedAt: at } : { url, lastVisitedAt: at };
  return [entry, ...rest].slice(0, RECENTS_MAX);
}

export function removeVisit(entries: ReadonlyArray<BrowserHistoryEntry>, url: string): BrowserHistoryEntry[] {
  return entries.filter(e => e.url !== url);
}

export function useRecents(workspaceId: string): [BrowserHistoryEntry[], (next: (prev: BrowserHistoryEntry[]) => BrowserHistoryEntry[]) => void] {
  return useLocalStorage(recentsKey(workspaceId), EMPTY, codec);
}

/** "just now", "4m ago", "2h ago", "3d ago". */
export function relativeLabel(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
