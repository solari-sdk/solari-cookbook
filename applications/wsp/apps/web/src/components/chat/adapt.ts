// SPDX-License-Identifier: AGPL-3.0-only
// The chat's one import path for view models. src/adapt owns every derivation
// from wire events; the few types below are what the copied rows read that no
// wire event produces yet (checkpoint diffs, harness skills, the timestamp
// setting) and the two id aliases the copies name.
export * from "../../adapt/index.js";
import type { ToolLifecycleItemType } from "../../adapt/index.js";

export type MessageId = string;
export type TurnId = string;

const TOOL_LIFECYCLE_ITEM_TYPES: ReadonlyArray<ToolLifecycleItemType> = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
];
export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return (TOOL_LIFECYCLE_ITEM_TYPES as ReadonlyArray<string>).includes(value);
}

export type TimestampFormat = "locale" | "12-hour" | "24-hour";
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

/** The two fields of a harness skill the chat renders (inline `$skill` chips). */
export interface ProviderSkill {
  readonly name: string;
  readonly displayName?: string | undefined;
}

export interface TurnDiffFileChange {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}
export type TurnDiffStatus = "ready" | "missing" | "error";
export interface TurnDiffSummary {
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: string;
  readonly status: TurnDiffStatus;
  readonly files: ReadonlyArray<TurnDiffFileChange>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}
