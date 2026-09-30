import type { Terminal } from '../backend/types.ts';
import { EXIT_MARKER } from './guest.ts';

/** The user's side of an interactive session (raw TTY in production, a fake in tests). */
export interface LocalTerminal {
  size(): { cols: number; rows: number };
  write(data: Uint8Array | string): void;
  /** Starts forwarding raw input and resize events. Returns a function that stops and restores. */
  start(onInput: (data: Uint8Array) => void, onResize: () => void): () => void;
}

/** Ctrl-], as in telnet and ssh-style tools. */
export const DETACH_BYTE = 0x1d;

export type SessionEnd = 'exited' | 'detached';

/**
 * Wires a local terminal to a guest terminal until the guest shell prints the exit marker or the
 * user presses Ctrl-]. The marker can arrive split across chunks, so a short tail is kept.
 */
export function attach(remote: Terminal, local: LocalTerminal): Promise<SessionEnd> {
  return new Promise((resolve) => {
    let finished = false;
    let pending = '';
    const decoder = new TextDecoder();

    const finish = (reason: SessionEnd) => {
      if (finished) return;
      finished = true;
      stop();
      remote.close().catch(() => {});
      resolve(reason);
    };

    remote.onData((bytes) => {
      if (finished) return;
      const text = pending + decoder.decode(bytes, { stream: true });
      const at = text.indexOf(EXIT_MARKER);
      if (at !== -1) {
        local.write(text.slice(0, at));
        finish('exited');
        return;
      }
      // Hold back anything that could be the start of a split marker.
      const keep = partialMarkerLength(text);
      local.write(text.slice(0, text.length - keep));
      pending = text.slice(text.length - keep);
    });

    const stop = local.start(
      (input) => {
        const detach = input.indexOf(DETACH_BYTE);
        if (detach !== -1) {
          if (detach > 0) void remote.write(input.subarray(0, detach));
          finish('detached');
          return;
        }
        void remote.write(input);
      },
      () => {
        const { cols, rows } = local.size();
        void remote.resize(cols, rows);
      },
    );
  });
}

/** Length of the longest suffix of `text` that is a proper prefix of the exit marker. */
function partialMarkerLength(text: string): number {
  for (let length = Math.min(EXIT_MARKER.length - 1, text.length); length > 0; length--) {
    if (EXIT_MARKER.startsWith(text.slice(-length))) return length;
  }
  return 0;
}
