/**
 * A `DoctorContext` whose SDK clients are stubs.
 *
 * design.md §10: unit tests never reach a live Solari service. Checks receive
 * the client through the context, so replacing it here is the whole seam.
 *
 * The stubs are cast to the real client types. They implement only the methods
 * a check under test calls, which keeps a fixture from quietly growing into a
 * second implementation of the SDK.
 */

import type { Solari } from "@solarisdk/browser";
import type { SolariClient } from "@solarisdk/sdk";

import { createDoctorContext, type Clock, type DoctorContext } from "../../src/context.js";

export interface FakeContextOptions {
  apiKey?: string | undefined;
  projectRoot?: string;
  clock?: Clock;
  /** Stand-in for `client.sandboxes.list`. Throw to simulate an SDK error. */
  sandboxList?: (options?: unknown) => Promise<unknown>;
  /** A complete replacement client, for checks that do more than list. */
  sandboxClient?: SolariClient;
  /** Called if a check requests the browser client. */
  onBrowser?: () => Solari;
}

/** Records what a check asked the context for, so tests can assert on it. */
export interface FakeContextCalls {
  sandboxListCalls: unknown[];
  browserRequested: number;
  sandboxRequested: number;
}

export function fakeContext(options: FakeContextOptions = {}): {
  ctx: DoctorContext;
  calls: FakeContextCalls;
} {
  const calls: FakeContextCalls = {
    sandboxListCalls: [],
    browserRequested: 0,
    sandboxRequested: 0,
  };

  const base = createDoctorContext({
    apiKey: options.apiKey,
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });

  const sandboxStub = {
    sandboxes: {
      list: async (listOptions?: unknown) => {
        calls.sandboxListCalls.push(listOptions);
        if (options.sandboxList === undefined) return { sandboxes: [] };
        return options.sandboxList(listOptions);
      },
    },
  } as unknown as SolariClient;

  const ctx: DoctorContext = {
    ...base,
    browser: () => {
      calls.browserRequested += 1;
      if (options.onBrowser === undefined) {
        throw new Error("fakeContext: browser() was called but no stub was provided");
      }
      return options.onBrowser();
    },
    sandbox: () => {
      calls.sandboxRequested += 1;
      return options.sandboxClient ?? sandboxStub;
    },
  };

  return { ctx, calls };
}
