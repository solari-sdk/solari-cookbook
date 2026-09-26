// Adapted from pingdotgg/t3code apps/web/src/components/chat/ComposerPrimaryActions.test.tsx at 57a66608 (MIT).
// Differs from upstream: the settings and stage-artwork mocks and their two cases are dropped with the artwork branch.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderRunningActions(showSendWhileRunning: boolean, hasSendableContent: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: hasSendableContent,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent,
      showSendWhileRunning,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderStoppingActions() {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      isInterruptPending: true,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(sendDisabledReason: string | null = null, wakesFirst = false) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      wakesFirst,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("names the send Wake and send while the machine is paused, on the same button, and Send message otherwise", () => {
    expect(renderSendButton(null, true)).toContain('aria-label="Wake and send"');
    expect(renderSendButton(null, true)).toContain('title="Wake and send"');
    expect(renderSendButton(null, true)).not.toMatch(/<button[^>]* disabled=""/);
    expect(renderSendButton()).toContain('aria-label="Send message"');
    expect(renderSendButton()).not.toContain("title=");
  });

  it("takes the accent off a send held for a reason and says why on hover, and gives the accent back when it can be pressed", () => {
    const held = renderSendButton("Connecting to wsp");
    expect(held).toContain('title="Connecting to wsp"');
    expect(held).toMatch(/<button[^>]* disabled=""/);
    // The held tier ui/button.tsx gives a primary that cannot be pressed, in the same slot: the window's one loud
    // thing is not loud while it refuses the press, and no amount of blue at a lower opacity reads as held.
    expect(held).toContain("border-input");
    expect(held).toContain("bg-popover");
    expect(held).toContain("dark:bg-input/32");
    expect(held).toContain("text-muted-foreground");
    expect(held).not.toContain("bg-message-action");
    expect(held).not.toContain("disabled:opacity-64");
    // Nothing typed is not a hold: no reason to give, and the accent at the fainter weight it has always had.
    const empty = renderSendButton();
    expect(empty).toContain("bg-message-action");
    expect(empty).toContain("disabled:opacity-30");
    expect(empty).not.toContain("border-input");
    // A send that wakes the machine first is a send that can be pressed, so it keeps the accent too.
    expect(renderSendButton(null, true)).toContain("bg-message-action");
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("only renders stop while running when Enter-to-send is available", () => {
    const markup = renderRunningActions(false, true);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message"');
  });

  it("renders send alongside stop while running when Enter-to-send is unavailable", () => {
    const markup = renderRunningActions(true, true);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toContain('type="submit"');
  });

  it("disables stop and labels it Stopping while the interrupt request is in flight", () => {
    const markup = renderStoppingActions();

    expect(markup).toContain('aria-label="Stopping"');
    // The attribute, not the disabled: class prefix the button always carries.
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('aria-label="Stop generation"');
  });

  it("keeps stop as the only action while running with an empty composer", () => {
    const markup = renderRunningActions(true, false);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message"');
  });
});
