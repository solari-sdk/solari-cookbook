import type { EventEmitter } from 'node:events';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type RequestId = string | number;

const requestId = (message: JSONRPCMessage): RequestId | undefined =>
  'method' in message && 'id' in message ? message.id : undefined;
const responseId = (message: JSONRPCMessage): RequestId | undefined =>
  !('method' in message) && 'id' in message ? message.id : undefined;

/**
 * Wraps a transport so that the end of its input (a client closing stdin) closes the session only
 * after every request already received has been answered. Without it, a replay still running when
 * input ends would be cut off before it could report.
 */
export function closeWhenAnswered(inner: Transport, input: EventEmitter): Transport {
  const pending = new Set<RequestId>();
  let ended = false;
  const closeIfDone = () => {
    if (ended && pending.size === 0) void inner.close();
  };
  const outer: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    send: async (message, options) => {
      await inner.send(message, options);
      const id = responseId(message);
      if (id !== undefined && pending.delete(id)) closeIfDone();
    },
  };
  inner.onmessage = (message, extra) => {
    const id = requestId(message);
    if (id !== undefined) pending.add(id);
    outer.onmessage?.(message, extra);
    // The SDK never answers a cancelled request, so it must stop holding the session open.
    if ('method' in message && message.method === 'notifications/cancelled') {
      const cancelled = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      if (cancelled !== undefined && pending.delete(cancelled)) closeIfDone();
    }
  };
  inner.onclose = () => outer.onclose?.();
  inner.onerror = (error) => outer.onerror?.(error);
  input.once('end', () => {
    ended = true;
    closeIfDone();
  });
  return outer;
}
