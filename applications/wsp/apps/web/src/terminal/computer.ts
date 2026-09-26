// SPDX-License-Identifier: AGPL-3.0-only
// The terminal that belongs to the computer the host runs on rather than to a
// workspace: ptys on that computer's own daemon, opened in its user's home
// folder. It lives in the same terminal registry and drawer store as a
// workspace's, under a key no workspace id can be.
import { HERE_PLACE_ID } from "@wsp/protocol";

export const HERE_KEY = `place:${HERE_PLACE_ID}`;

/** The key a terminal chord acts on: the selected workspace's, else this computer's. */
export const workspaceOrHere = (workspaceId: string | null): string => workspaceId ?? HERE_KEY;
