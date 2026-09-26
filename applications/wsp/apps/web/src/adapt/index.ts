// SPDX-License-Identifier: AGPL-3.0-only
// The adapter: pure functions from @wsp/protocol types to the view models the
// transplanted components accept. apps/web imports @wsp/protocol only; nothing
// here touches React, the store or a socket.
export * from "./view-model.js";
export { deriveSession, isPromptOpen, summarizeOutput, commandFirstLine, type SessionModel, type DeriveSessionOptions } from "./session.js";
export {
  deriveMessagesTimelineRows,
  entryTurnId,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  workEntryKind,
  isToolLike,
  indicatesFailure,
  indicatesSuccess,
  indicatesNeutral,
  type DeriveRowsInput,
} from "./timeline-rows.js";
export {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PromptEvent,
  type ApprovalRequestedEvent,
  type ApprovalResolvedEvent,
  type UserInputRequestedEvent,
  type UserInputResolvedEvent,
  type PromptRespondFailedEvent,
} from "./prompts.js";
export {
  applyPortsSnapshot,
  applyPortEvent,
  applyStoppedEvent,
  MOVED_WINDOW_MS,
  stoppedSentence,
  toPreviewableServers,
  type KnownPort,
  type PortsSnapshot,
  type PreviewableServersInput,
  type StoppedPort,
} from "./ports.js";
export { deriveSidebarProjects, sidebarWorkspaceOrder, workspaceIndicator, threadIndicator, pausedLine, turnWait, type SidebarInput } from "./workspaces.js";
export { terminalPaneState, terminalPaneTitle, terminalPaneHints, terminalEmptyLine, terminalInputRefusal, linkDownLine, SHELL_ENDED_LINE, type TerminalPaneState, type TerminalPaneInput } from "./terminal-pane.js";
export { toTerminalAttachEvent, isPtyEvent } from "./terminal.js";
export { catalogFor, catalogFromHarness, composerPlaceholder, offersSlashCommands, slashHoldLine } from "./catalog.js";
export { repoAbsence } from "./git.js";
export { HARNESS_CLIENTS, harnessClient, type HarnessClient } from "./harnesses.js";
