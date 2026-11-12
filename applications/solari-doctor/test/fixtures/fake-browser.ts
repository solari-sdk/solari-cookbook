/**
 * A scripted stand-in for `Solari` and `BrowserSession`.
 *
 * The browser checks create real sessions, so no unit test may reach the live
 * API (design.md §10). Every call is recorded so a test can assert the session
 * was released even on a failing path.
 *
 * Shapes here mirror what was actually observed live (findings F31, F32) rather
 * than what the types merely permit — F42 caught a fixture that resembled an
 * SDK error closely enough to pass while testing a different program.
 */

import type { Solari } from "@solarisdk/browser";

export interface BrowserCalls {
  launched: number;
  launchOptions: unknown[];
  newPages: number;
  closed: number;
  clientClosed: number;
  released: string[];
  replayUrlRequests: string[];
}

export interface FakeBrowserOptions {
  sessionId?: string;
  /** Throw to simulate a launch failure. */
  launch?: (options?: unknown) => void;
  /** Sequence of `isConnected()` results; the last value repeats. */
  connected?: readonly boolean[];
  /** Fires the `disconnected` listener when `releaseAndWait` is called. */
  emitDisconnectOnRelease?: boolean;
  /** Throw to simulate a page call against a dead session. */
  newPage?: () => void;
  releaseAndWait?: (id: string) => void;
  /** Called with the zero-based poll index; throw to simulate a 404. */
  getReplayUrl?: (id: string, callIndex: number) => { url: string; expiresInSeconds: number; contentEncoding: string };
}

export function fakeSolari(options: FakeBrowserOptions = {}): {
  solari: Solari;
  calls: BrowserCalls;
} {
  const sessionId = options.sessionId ?? "ip-10-0-0-1:fake-session";
  const calls: BrowserCalls = {
    launched: 0,
    launchOptions: [],
    newPages: 0,
    closed: 0,
    clientClosed: 0,
    released: [],
    replayUrlRequests: [],
  };

  const connectedSequence = options.connected ?? [true, false];
  let connectedIndex = 0;
  const disconnectListeners: Array<() => void> = [];

  const session = {
    id: sessionId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    isConnected: (): boolean => {
      const value =
        connectedSequence[Math.min(connectedIndex, connectedSequence.length - 1)] ?? false;
      connectedIndex += 1;
      return value;
    },
    raw: {
      on: (event: string, listener: () => void): void => {
        if (event === "disconnected") disconnectListeners.push(listener);
      },
    },
    newPage: async (): Promise<unknown> => {
      calls.newPages += 1;
      options.newPage?.();
      return { goto: async (): Promise<void> => undefined };
    },
    close: async (): Promise<void> => {
      calls.closed += 1;
    },
  };

  const solari = {
    launch: async (launchOptions?: unknown): Promise<unknown> => {
      calls.launched += 1;
      calls.launchOptions.push(launchOptions);
      options.launch?.(launchOptions);
      return session;
    },
    close: async (): Promise<void> => {
      calls.clientClosed += 1;
    },
    sessions: {
      releaseAndWait: async (id: string): Promise<void> => {
        calls.released.push(id);
        options.releaseAndWait?.(id);
        if (options.emitDisconnectOnRelease !== false) {
          for (const listener of disconnectListeners) listener();
        }
      },
      getReplayUrl: async (id: string): Promise<unknown> => {
        const index = calls.replayUrlRequests.length;
        calls.replayUrlRequests.push(id);
        if (options.getReplayUrl === undefined) {
          return { url: "https://replay.example/x", expiresInSeconds: 900, contentEncoding: "gzip" };
        }
        return options.getReplayUrl(id, index);
      },
    },
  } as unknown as Solari;

  return { solari, calls };
}

/** A clock that records sleeps instead of performing them. */
export function fakeClock(): { clock: { now(): number; sleep(ms: number): Promise<void> }; slept: number[] } {
  const slept: number[] = [];
  let time = 0;
  return {
    slept,
    clock: {
      now: () => time,
      sleep: async (ms: number) => {
        slept.push(ms);
        time += ms;
      },
    },
  };
}
