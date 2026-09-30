import { EventEmitter } from 'node:events';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { closeWhenAnswered } from '../../src/mcp/transport.ts';

function fakeTransport() {
  const sent: JSONRPCMessage[] = [];
  const state = { started: false, closed: 0 };
  const inner: Transport = {
    start: async () => {
      state.started = true;
    },
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {
      state.closed += 1;
      inner.onclose?.();
    },
  };
  return { inner, sent, state };
}

const request = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, method: 'tools/call' });
const response = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, result: {} });

describe('closeWhenAnswered', () => {
  it('closes after input ends only once every received request is answered', async () => {
    const { inner, sent, state } = fakeTransport();
    const input = new EventEmitter();
    const outer = closeWhenAnswered(inner, input);
    const received: JSONRPCMessage[] = [];
    let closed = false;
    outer.onmessage = (message) => received.push(message);
    outer.onclose = () => {
      closed = true;
    };
    await outer.start();
    expect(state.started).toBe(true);

    inner.onmessage?.(request(1));
    inner.onmessage?.(request(2));
    inner.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
    input.emit('end');
    expect(received).toHaveLength(3);

    await outer.send(response(1));
    // Notifications from the server (progress) are not answers.
    await outer.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
    expect(state.closed).toBe(0);
    await outer.send(response(2));
    expect(state.closed).toBe(1);
    expect(closed).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it('closes at once when nothing is pending, and forwards errors and explicit closes', async () => {
    const { inner, state } = fakeTransport();
    const input = new EventEmitter();
    const outer = closeWhenAnswered(inner, input);
    const errors: Error[] = [];
    outer.onerror = (error) => errors.push(error);
    inner.onerror?.(new Error('bad frame'));
    expect(errors.map((e) => e.message)).toEqual(['bad frame']);
    await outer.close();
    expect(state.closed).toBe(1);
    input.emit('end');
    expect(state.closed).toBe(2);
  });
});
