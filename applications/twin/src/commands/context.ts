import type { Backend } from '../backend/types.ts';
import type { CapsuleSourceOptions } from '../capsule/source.ts';
import type { Host } from '../host.ts';
import type { Io } from '../io.ts';
import { createStyle, type Style, shouldColor } from '../report/style.ts';

export interface CommandContext {
  io: Io;
  host: Host;
  cwd: string;
  version: string;
  /** Resolved lazily so offline commands never need a key or load the SDK. */
  getBackend: () => Promise<Backend>;
}

/** Sections of `twin --help`, in the order a bug moves through them. */
export type CommandGroup = 'report' | 'reproduce' | 'machines' | 'agents';

export interface Command {
  name: string;
  summary: string;
  group?: CommandGroup;
  /** Other names that run this command; not listed in help (old names keep working). */
  aliases?: readonly string[];
  usage: string;
  run(args: string[], context: CommandContext): Promise<number>;
}

/** Capsule arguments are paths relative to the working directory, or https URLs. */
export function capsuleSource(context: CommandContext): CapsuleSourceOptions {
  return { cwd: context.cwd, fetch: context.host.fetch };
}

/** Style for human-facing messages, which twin writes to stderr. */
export function stderrStyle(context: CommandContext): Style {
  return createStyle(shouldColor(context.io.stderr.isTTY, context.host.env));
}

export function stdoutStyle(context: CommandContext): Style {
  return createStyle(shouldColor(context.io.stdout.isTTY, context.host.env));
}
