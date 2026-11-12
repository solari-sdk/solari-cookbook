/**
 * One live sandbox at a time, across every check that creates one.
 *
 * Finding F52: a second `sandboxes.create()` while one VM is alive returns
 * `429 ConcurrencyLimitExceeded` on a one-sandbox account. The scheduler starts
 * `sandbox-command` and `sandbox-cleanup` in the same cheap-phase batch, so
 * without this the doctor tripped the limit itself and blamed the user's
 * environment for it.
 *
 * Each sandbox check takes the slot before `create()` and gives it back in its
 * `finally`, after `kill()`, so the next VM is only requested once the previous
 * one is gone. Browser checks are unaffected and still run alongside.
 */

let tail: Promise<void> = Promise.resolve();

/**
 * Waits for the slot and resolves to its release function. Releasing twice is
 * harmless, so every exit path can call it without tracking whether another
 * already did.
 */
export async function acquireSandboxSlot(): Promise<() => void> {
  let open!: () => void;
  const done = new Promise<void>((resolve) => {
    open = resolve;
  });
  const previous = tail;
  tail = previous.then(() => done);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    open();
  };
}
