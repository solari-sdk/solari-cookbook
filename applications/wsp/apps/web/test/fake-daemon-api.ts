// SPDX-License-Identifier: AGPL-3.0-only
import type { DaemonApi } from "../src/protocol/client.js";

/** The daemon road for a fixture with no host behind it. Every pane it feeds reads as a link that never opened,
 * which is what a fixture that never wired a runtime has: relay-harness.ts is the one that really relays. */
export const noDaemonApi: DaemonApi = {
  open: async () => {
    throw new Error("this test has no host to relay through");
  },
  send: async () => {
    throw new Error("this test has no host to relay through");
  },
  close: async () => {},
  onFrame: () => () => {},
};
