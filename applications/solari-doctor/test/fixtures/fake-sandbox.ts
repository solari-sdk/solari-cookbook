/**
 * A scripted stand-in for `SolariClient.sandboxes`.
 *
 * The sandbox checks create real, billable VMs, so no unit test may reach the
 * live API (design.md §10). Every call is recorded so a test can assert that
 * `kill()` ran even on a failing path.
 */

import { GatewayError } from "@solarisdk/sdk";
import type { SolariClient } from "@solarisdk/sdk";

export interface CommandResultLike {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxCalls {
  created: number;
  connected: number;
  /** Every `commands.run` as `[command, args]`. */
  ran: Array<[string, readonly string[] | undefined]>;
  closed: number;
  killed: number;
  /** Every id passed to `sandboxes.get`. */
  got: string[];
}

export interface FakeSandboxOptions {
  sandboxId?: string;
  /** Throw to simulate a creation failure. */
  create?: () => void;
  connect?: () => void;
  run?: (command: string, args: readonly string[] | undefined) => CommandResultLike;
  /** Called with the zero-based call index, so a sequence can be scripted. */
  get?: (id: string, callIndex: number) => { state: string };
  kill?: () => void;
  close?: () => void;
}

export function fakeSandboxClient(options: FakeSandboxOptions = {}): {
  client: SolariClient;
  calls: SandboxCalls;
} {
  const sandboxId = options.sandboxId ?? "sbx_fake_0001";
  const calls: SandboxCalls = {
    created: 0,
    connected: 0,
    ran: [],
    closed: 0,
    killed: 0,
    got: [],
  };

  const handle = {
    sandboxId,
    id: sandboxId,
    connect: async (): Promise<void> => {
      calls.connected += 1;
      options.connect?.();
    },
    commands: {
      run: async (
        command: string,
        runOptions?: { args?: readonly string[] },
      ): Promise<CommandResultLike> => {
        calls.ran.push([command, runOptions?.args]);
        if (options.run === undefined) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return options.run(command, runOptions?.args);
      },
    },
    close: (): void => {
      calls.closed += 1;
      options.close?.();
    },
    kill: async (): Promise<void> => {
      calls.killed += 1;
      options.kill?.();
    },
  };

  const client = {
    sandboxes: {
      create: async (): Promise<unknown> => {
        calls.created += 1;
        options.create?.();
        return handle;
      },
      get: async (id: string): Promise<{ state: string }> => {
        const index = calls.got.length;
        calls.got.push(id);
        if (options.get === undefined) return { state: "running" };
        return options.get(id, index);
      },
      kill: async (): Promise<void> => {
        calls.killed += 1;
      },
    },
  } as unknown as SolariClient;

  return { client, calls };
}

/**
 * A real `GatewayError`, for scripting a 404 after `kill()`.
 *
 * The genuine class rather than an `Error` with a `status` property: the shared
 * error layer matches on `instanceof`, so a look-alike would be classified as
 * an unrecognised error and the test would prove nothing (finding F39).
 */
export function gatewayError(status: number, message = "not found"): GatewayError {
  return new GatewayError(status, message);
}
