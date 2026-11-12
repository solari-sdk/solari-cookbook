/**
 * Execution context passed to every check. See design.md §5.
 *
 * Fields are derived from what the seven checks require. Deliberately absent:
 * a logger (checks do not print, design.md §4), a `full` flag (the scheduler
 * gates by cost tier, §7), desktop/template/volume clients (unused by any
 * check), and the child-process harness paths (§5 marks these provisional
 * until browser-lifecycle needs them).
 */

import { Solari, type SolariRegion } from "@solarisdk/browser";
import { SolariClient } from "@solarisdk/sdk";

/** Injected so poll and deadline logic can be tested without real waits. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Deadlines {
  /** browser-lifecycle: deadline for the child process to exit. */
  childExitMs: number;
  /** recording-lifecycle: how long to poll for a replay URL. */
  replayPollMs: number;
}

export interface DoctorContext {
  /** Never logged, never placed in `evidence`, never in `--report`. */
  readonly apiKey: string | undefined;

  /**
   * Root used to resolve the user's installed SDK. Defaults to
   * `process.cwd()`.
   *
   * solari-doctor depends on `@solarisdk/browser` itself, so resolving through
   * its own module graph would report the doctor's version rather than the
   * user's (findings F35, §19.2).
   */
  readonly projectRoot: string;

  /** Omitted means the SDK default (`"us-west"`). */
  readonly region?: SolariRegion;
  /** Omitted means the SDK default (`https://api.getsolari.com`). */
  readonly baseUrl?: string;

  /** Constructed on first call and memoised. */
  browser(): Solari;
  sandbox(): SolariClient;

  /**
   * Releases anything the accessors constructed.
   *
   * Called once by the CLI after every check has finished. Checks must not
   * close these clients themselves: the instances are shared, so the first
   * check to finish would close the client the next one needs (finding F43).
   */
  dispose(): Promise<void>;

  readonly clock: Clock;
  readonly deadlines: Deadlines;
}

export interface DoctorContextOptions {
  apiKey?: string | undefined;
  projectRoot?: string | undefined;
  region?: SolariRegion | undefined;
  baseUrl?: string | undefined;
  clock?: Clock | undefined;
  deadlines?: Partial<Deadlines> | undefined;
}

/**
 * ~1.7x the healthy exit time measured on 0.1.3 (~3s, finding F27). A 3s
 * deadline would sit on top of the measured-good case and report a working
 * environment as hung. The failing case is unbounded (0.1.2 was still hung at
 * 75s), so extra margin costs no detection power.
 */
const DEFAULT_CHILD_EXIT_MS = 5_000;

/**
 * The cookbook documents ~30s (design.md §6.4); the remainder is margin and
 * must be described as ours, not as a Solari figure.
 *
 * Not a verified window. A6 is open: one run produced a replay at 8.2s, another
 * saw none within 60s (finding F33).
 */
const DEFAULT_REPLAY_POLL_MS = 45_000;

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * Returns the key, or throws if it is absent.
 *
 * Reaching this is a scheduler bug rather than a user-facing path: `auth`
 * reports a missing key as a `CheckResult`, and dependents are skipped before
 * any client is requested.
 */
function requireApiKey(apiKey: string | undefined, what: string): string {
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `Cannot construct the ${what} client: SOLARI_API_KEY is not set. ` +
        `The auth check reports this condition; dependent checks should be ` +
        `skipped rather than reaching this point.`,
    );
  }
  return apiKey;
}

/** Builds a context. No client is constructed until its accessor is called. */
export function createDoctorContext(
  options: DoctorContextOptions = {},
): DoctorContext {
  const apiKey = options.apiKey;
  const projectRoot = options.projectRoot ?? process.cwd();
  const clock = options.clock ?? systemClock;

  const deadlines: Deadlines = {
    childExitMs: options.deadlines?.childExitMs ?? DEFAULT_CHILD_EXIT_MS,
    replayPollMs: options.deadlines?.replayPollMs ?? DEFAULT_REPLAY_POLL_MS,
  };

  let browserClient: Solari | undefined;
  let sandboxClient: SolariClient | undefined;

  return {
    apiKey,
    projectRoot,
    // Conditional spread: `exactOptionalPropertyTypes` requires an unsupplied
    // option to stay absent rather than become an explicit `undefined`.
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    clock,
    deadlines,

    browser(): Solari {
      browserClient ??= new Solari({
        apiKey: requireApiKey(apiKey, "browser"),
        ...(options.region !== undefined ? { region: options.region } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      });
      return browserClient;
    },

    async dispose(): Promise<void> {
      // Optional on >= 0.1.3, where browser.close() alone releases the event
      // loop (finding F18); it still returns the client's pool immediately.
      try {
        await browserClient?.close();
      } catch {
        // Disposal is best-effort and must not mask a check's result.
      }
      browserClient = undefined;
      sandboxClient = undefined;
    },

    sandbox(): SolariClient {
      // SolariClient rather than the standalone SandboxClient: `baseUrl` is
      // optional here and required there, so the standalone client would force
      // a hardcoded gateway URL (decision C8, design.md §6.5).
      sandboxClient ??= new SolariClient({
        apiKey: requireApiKey(apiKey, "sandbox"),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      });
      return sandboxClient;
    },
  };
}
