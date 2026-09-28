// SPDX-License-Identifier: AGPL-3.0-only
// The mark wsp writes into the name of every snapshot and template it makes, and the one parser that reads it
// back. A machine carries its owner in the provider's metadata (labels.ts); a snapshot cannot. Solari's
// POST /sandboxes/:id/snapshots and POST /snapshots/:id/promote take a name and nothing else, and GET /snapshots
// answers {id, parent, name, sizeBytes, createdAt, kind, template} with no metadata field, so the name is the only
// place ownership can ride.

/** Every name below opens with this word, and the parser reads it back off the same one. */
const MARK = "wsp";

/** The host segment is the class templateHost() reduces a host identity to: lowercase letters and digits. What
 * follows is free, so a golden or a project whose name carries hyphens still reads back to the same host. */
const MARKED = new RegExp(`^${MARK}-([a-z0-9]+)-(.+)$`);

function marked(host: string, rest: string): string {
  if (!/^[a-z0-9]+$/.test(host)) throw new Error(`a snapshot name needs a host of lowercase letters and digits, got ${JSON.stringify(host)}`);
  return `${MARK}-${host}-${rest}`;
}

/** A golden version's snapshot and the template promoted from it: one name for one version. The host is in it
 * because the provider lets two names collide, so two hosts on one account with the same golden would read as one. */
export const goldenName = (host: string, golden: string, version: number): string => marked(host, `${golden}-v${version}`);

/** A project golden's snapshot: the workspace's project as it stood, stamped by the clock that took it. */
export const projectSnapshotName = (host: string, project: string, stamp: string): string => marked(host, `project-${project}-${stamp}`);

/** The host that made this snapshot or template, or undefined when the name carries no wsp mark. */
export function nameOwner(name: string | undefined): string | undefined {
  return name === undefined ? undefined : MARKED.exec(name)?.[1];
}
