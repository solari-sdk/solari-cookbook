// SPDX-License-Identifier: AGPL-3.0-only
// What the composer's send button calls itself, one word per state it can be
// in. The button's name is the only place the app says out loud whether it is
// ready for a key press, so two things read these words: the button, and the
// harness that drives the built app from node with no build step in front of
// it. That is why this file is plain JavaScript rather than a module of the
// app's own language: one file both can open.
//
// A second copy of the words in the harness is what this prevents. Rewording
// "Connecting" there and not here would send every driven step back to landing
// on a page that was still loading, silently, which is the fault this file's
// one home was written to close.

/** The send button's name in each state, and nowhere else. The keys are what another reader names a state by, so a
 * rewording here moves every reader with it. */
export const COMPOSER_STATE_WORDS = {
  workspaceUnavailable: "Workspace disconnected",
  connecting: "Connecting",
  preparingWorktree: "Preparing worktree",
  sending: "Sending",
  send: "Send message",
  wakeAndSend: "Wake and send",
};
