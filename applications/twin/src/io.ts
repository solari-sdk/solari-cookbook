import { createInterface } from 'node:readline/promises';
import type { LocalTerminal } from './shell/session.ts';

export interface Output {
  write(chunk: string | Uint8Array): void;
  readonly isTTY: boolean;
}

/** Terminal interaction, injected so commands can be driven from tests. */
export interface Io {
  stdout: Output;
  stderr: Output;
  /** True when a person can answer prompts. */
  interactive: boolean;
  /** Asks on stderr and returns the answer, or null if input ended. */
  prompt(question: string): Promise<string | null>;
  /** Raw terminal access for interactive sessions; absent when stdin/stdout is not a TTY. */
  terminal?: LocalTerminal;
}

function wrap(stream: NodeJS.WriteStream): Output {
  return {
    write: (chunk) => {
      stream.write(chunk);
    },
    get isTTY() {
      return stream.isTTY === true;
    },
  };
}

function processTerminal(): LocalTerminal {
  return {
    size: () => ({ cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }),
    write: (data) => {
      process.stdout.write(data);
    },
    start: (onInput, onResize) => {
      const input = (chunk: Buffer) => onInput(chunk);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', input);
      process.stdout.on('resize', onResize);
      return () => {
        process.stdin.off('data', input);
        process.stdout.off('resize', onResize);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      };
    },
  };
}

export function processIo(): Io {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return {
    ...(tty ? { terminal: processTerminal() } : {}),
    stdout: wrap(process.stdout),
    stderr: wrap(process.stderr),
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } catch {
        return null;
      } finally {
        rl.close();
      }
    },
  };
}
