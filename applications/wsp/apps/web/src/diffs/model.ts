// SPDX-License-Identifier: AGPL-3.0-only
// From a git.diff reply to what the copied diff components read: parsed
// file diffs keyed for the code view, a line stat, and the changed-files
// rows for the tree. A file the daemon listed with an empty patch (over its
// byte budget) still appears in the tree so the reader knows it changed.
import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitDiffReply, GitDiffScope } from "@wsp/protocol";
import type { TurnDiffFileChange } from "../components/chat/adapt.js";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
  type DiffLineStat,
} from "../lib/diffRendering.js";

export const SCOPE_LABELS: Record<GitDiffScope, string> = {
  unstaged: "Working tree",
  staged: "Staged",
  branch: "Branch changes",
};

export const SCOPES: readonly GitDiffScope[] = ["unstaged", "staged", "branch"];

export interface DiffFile {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly fileKey: string;
  readonly fileVersion: number;
}

export interface DiffModel {
  readonly files: readonly DiffFile[];
  readonly stat: DiffLineStat;
  readonly changedFiles: readonly TurnDiffFileChange[];
  /** Set when the patch text could not be parsed into files. */
  readonly raw: { readonly text: string; readonly reason: string } | null;
}

function changeKind(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

export function toDiffModel(reply: GitDiffReply, cacheScope: string): DiffModel {
  const patch = reply.files.map(f => f.patch).filter(p => p.length > 0).join("\n");
  const renderable = getRenderablePatch(patch, cacheScope);
  if (renderable?.kind === "raw") {
    return { files: [], stat: { additions: 0, deletions: 0 }, changedFiles: [], raw: renderable };
  }
  const files: DiffFile[] = (renderable?.files ?? []).map(fileDiff => ({
    fileDiff,
    filePath: resolveFileDiffPath(fileDiff),
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  }));
  const parsedPaths = new Set(files.map(f => f.filePath));
  const changedFiles: TurnDiffFileChange[] = files.map(f => {
    const stat = getDiffLineStat([f.fileDiff]);
    return { path: f.filePath, kind: changeKind(f.fileDiff), additions: stat.additions, deletions: stat.deletions };
  });
  for (const f of reply.files) {
    if (!parsedPaths.has(f.path)) changedFiles.push({ path: f.path, kind: "modified", additions: 0, deletions: 0 });
  }
  return { files, stat: getDiffLineStat(files.map(f => f.fileDiff)), changedFiles, raw: null };
}
