// SPDX-License-Identifier: AGPL-3.0-only
// Paths as the daemon takes them: absolute, inside the root its hello named
// (the workspace HOME unless it was started with --root). Every entry the
// panes hold is one, so a file can be read, a directory listed and a session
// started with the string as it is.
import type { FsListReply } from "@wsp/protocol";

export interface ProjectEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** null at the filesystem root, where there is nowhere up to go. */
export function parentPath(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export interface PathSegment {
  /** The one folder or file name this segment is. */
  readonly name: string;
  /** The absolute path the segment names, root included. */
  readonly path: string;
}

/** Every segment of path below root, in order, each with the absolute path it names; empty at the root itself. */
export function pathSegments(root: string, path: string): PathSegment[] {
  const parts = relativeTo(root, path).split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: joinPath(root, parts.slice(0, index + 1).join("/")) }));
}

/** path below root as the tree shows it; the root itself is "". */
export function relativeTo(root: string, path: string): string {
  if (path === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** A symlink is listed as a file: fs.read follows it, fs.list never descends. */
export function toProjectEntries(reply: FsListReply, dir: string): ProjectEntry[] {
  return reply.entries.map(entry => ({ path: joinPath(dir, entry.name), kind: entry.type === "dir" ? "directory" : "file" }));
}

export function isMarkdownFile(path: string): boolean {
  return /\.(?:md|mdx)$/i.test(path);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
