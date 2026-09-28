// SPDX-License-Identifier: AGPL-3.0-only
// The two things this host starts for the workspace that is this computer on
// the first ask and keeps: the daemon its terminal, files and processes dial,
// and the sampler its Live rows read. Both are held as a promise, and a held
// promise that rejected is the failure kept for the life of the host: every
// later ask answers with the first one and nothing tries again. So a start
// that failed is let go of, and its reason is said once per reason rather
// than once per ask, since a page that is waiting asks again every few
// seconds.
export interface StartedOnce<T> {
  /** What it holds, started on the first ask. */
  get(): Promise<T>;
  /** What it holds now, for a caller that must close what was started and has no reason to start one to close;
   * nothing before the first ask and nothing after a start that failed. */
  held(): Promise<T> | undefined;
  /** Lets go of what it holds, so the next ask starts another. */
  forget(): void;
}

export function startOnce<T>(start: () => Promise<T>, say: (why: string) => string): StartedOnce<T> {
  let holding: Promise<T> | undefined;
  /** The line the last failed start said, so the same one twice is one line. */
  let refused: string | undefined;
  return {
    async get() {
      const started = await (holding ??= start().catch((e: unknown) => {
        holding = undefined;
        const line = say(e instanceof Error ? e.message : String(e));
        if (refused !== line) {
          refused = line;
          console.warn(line);
        }
        throw new Error(line, { cause: e });
      }));
      refused = undefined;
      return started;
    },
    held: () => holding,
    forget: () => {
      holding = undefined;
    },
  };
}
