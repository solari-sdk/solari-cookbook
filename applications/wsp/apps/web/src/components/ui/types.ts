// SPDX-License-Identifier: AGPL-3.0-only
// Plain shapes standing in for the upstream contract types the copied kit
// reads; the adapter maps wsp workspaces and sessions onto them.
export type EnvironmentId = string;
export type ThreadId = string;

export interface ScopedThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}
