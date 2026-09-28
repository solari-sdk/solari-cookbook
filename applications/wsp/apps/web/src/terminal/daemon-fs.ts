// SPDX-License-Identifier: AGPL-3.0-only
// Typed calls for the daemon's files and diff ops over any TerminalWire (the
// daemon link in the app, a fake in tests). Replies are parsed against the
// protocol schemas so a malformed daemon answer fails here, not in a pane.
import {
  DaemonErrorCode,
  FsListReply,
  FsReadReply,
  GitDiffReply,
  GitStatusReply,
  type FsReadEncoding,
  type GitDiffScope,
} from "@wsp/protocol";
import type { TerminalWire } from "./link.js";

/** code is present only when the wire preserved the daemon's typed refusal. */
export class DaemonOpError extends Error {
  readonly code: DaemonErrorCode | undefined;
  constructor(message: string, code?: DaemonErrorCode) {
    super(message);
    this.code = code;
  }
}

function wrap(e: unknown): DaemonOpError {
  if (e instanceof DaemonOpError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const raw = (e as { code?: unknown } | null)?.code;
  const parsed = DaemonErrorCode.safeParse(raw);
  return new DaemonOpError(message, parsed.success ? parsed.data : undefined);
}

async function call<T>(wire: TerminalWire, op: string, params: Record<string, unknown>, schema: { parse(v: unknown): T }): Promise<T> {
  let reply: Record<string, unknown>;
  try {
    reply = await wire.request(op, params);
  } catch (e) {
    throw wrap(e);
  }
  return schema.parse(reply);
}

export interface FsListOpts {
  gitignore?: boolean;
}

export function fsList(wire: TerminalWire, path: string, opts: FsListOpts = {}): Promise<FsListReply> {
  const params: Record<string, unknown> = { path };
  if (opts.gitignore !== undefined) params["gitignore"] = opts.gitignore;
  return call(wire, "fs.list", params, FsListReply);
}

export function fsRead(wire: TerminalWire, path: string, encoding?: FsReadEncoding): Promise<FsReadReply> {
  const params: Record<string, unknown> = { path };
  if (encoding !== undefined) params["encoding"] = encoding;
  return call(wire, "fs.read", params, FsReadReply);
}

export function gitStatus(wire: TerminalWire, cwd: string): Promise<GitStatusReply> {
  return call(wire, "git.status", { cwd }, GitStatusReply);
}

export function gitDiff(wire: TerminalWire, cwd: string, scope: GitDiffScope, path?: string): Promise<GitDiffReply> {
  const params: Record<string, unknown> = { cwd, scope };
  if (path !== undefined) params["path"] = path;
  return call(wire, "git.diff", params, GitDiffReply);
}
