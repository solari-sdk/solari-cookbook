// SPDX-License-Identifier: AGPL-3.0-only
// What the centre pane says while a thread's transcript is still arriving, and
// nowhere else. Two things read it: the pane that draws it, and the harness
// that drives the built app from node, which must not photograph a thread
// until the words of that thread are on the page. Nine shots of a working
// thread came back blank or reading this line, because the harness waited on
// the shell and the send button alone.
//
// Plain JavaScript beside the app for the same reason the composer's words
// are: one file the app's build and a node harness can both open, so a
// rewording moves the wait with it.

/** The one line the pane shows in place of a transcript it has not got yet. */
export const TRANSCRIPT_LOADING = "loading transcript";
