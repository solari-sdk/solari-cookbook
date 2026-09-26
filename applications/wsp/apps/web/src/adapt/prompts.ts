// SPDX-License-Identifier: AGPL-3.0-only
// Approval and question prompts into the composer's PendingApproval and
// PendingUserInput lists. Ported from t3code session-logic.ts
// derivePendingApprovals and derivePendingUserInputs (commit 57a66608). The
// wsp wire has no approval or user-input event yet (sessions run with
// --dangerously-skip-permissions), so the event shapes below are the proposal
// for @wsp/protocol and the derive functions run on fixtures until it lands.
import type { PendingApproval, PendingUserInput, ProviderApprovalOption, ProviderRequestKind, UserInputQuestion } from "./view-model.js";

interface PromptScope {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly at: string;
}

export type ApprovalRequestedEvent = PromptScope & {
  readonly type: "approval.requested";
  readonly requestKind: ProviderRequestKind;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
};

export type ApprovalResolvedEvent = PromptScope & { readonly type: "approval.resolved" };

export type UserInputRequestedEvent = PromptScope & {
  readonly type: "user-input.requested";
  readonly questions: ReadonlyArray<UserInputQuestion>;
};

export type UserInputResolvedEvent = PromptScope & { readonly type: "user-input.resolved" };

/** A respond call the runtime refused because the request was already gone; the prompt closes locally. */
export type PromptRespondFailedEvent = PromptScope & {
  readonly type: "prompt.respond.failed";
  readonly reason: "stale" | "unknown" | "other";
};

export type PromptEvent = ApprovalRequestedEvent | ApprovalResolvedEvent | UserInputRequestedEvent | UserInputResolvedEvent | PromptRespondFailedEvent;

export function derivePendingApprovals(events: ReadonlyArray<PromptEvent>): PendingApproval[] {
  const open = new Map<string, PendingApproval>();
  for (const e of events) {
    switch (e.type) {
      case "approval.requested":
        open.set(e.requestId, {
          requestId: e.requestId,
          requestKind: e.requestKind,
          createdAt: e.at,
          ...(e.detail !== undefined ? { detail: e.detail } : {}),
          ...(e.appName !== undefined ? { appName: e.appName } : {}),
          ...(e.options !== undefined && e.options.length > 0 ? { options: e.options } : {}),
        });
        break;
      case "approval.resolved":
        open.delete(e.requestId);
        break;
      case "prompt.respond.failed":
        if (e.reason !== "other") open.delete(e.requestId);
        break;
      case "user-input.requested":
      case "user-input.resolved":
        break;
      default: {
        const _exhaustive: never = e;
      }
    }
  }
  return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function derivePendingUserInputs(events: ReadonlyArray<PromptEvent>): PendingUserInput[] {
  const open = new Map<string, PendingUserInput>();
  for (const e of events) {
    switch (e.type) {
      case "user-input.requested": {
        const questions = e.questions.filter(q => q.options.length > 0);
        if (questions.length === 0) break;
        open.set(e.requestId, { requestId: e.requestId, createdAt: e.at, questions });
        break;
      }
      case "user-input.resolved":
        open.delete(e.requestId);
        break;
      case "prompt.respond.failed":
        if (e.reason !== "other") open.delete(e.requestId);
        break;
      case "approval.requested":
      case "approval.resolved":
        break;
      default: {
        const _exhaustive: never = e;
      }
    }
  }
  return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
