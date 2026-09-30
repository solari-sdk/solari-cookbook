import { describe, expect, it } from 'vitest';
import { FakeBackend, type FakeMachine } from '../src/backend/fake.ts';
import { interruptible, type SignalSource } from '../src/interrupt.ts';
import { MemoryOutput } from './helpers/fakes.ts';

function fakeSignals() {
  const listeners = new Map<string, Set<() => void>>();
  const exits: number[] = [];
  let exited: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const signals: SignalSource = {
    on: (signal, listener) =>
      listeners.set(signal, (listeners.get(signal) ?? new Set()).add(listener)),
    off: (signal, listener) => listeners.get(signal)?.delete(listener),
    exit: (code) => {
      exits.push(code);
      exited();
    },
  };
  const send = (signal: string) => {
    for (const listener of listeners.get(signal) ?? []) listener();
  };
  const count = (signal: string) => listeners.get(signal)?.size ?? 0;
  return { signals, send, count, exits, done };
}

const labels = { app: 'twin' };

describe('interruptible', () => {
  it('listens only while a machine is live', async () => {
    const { signals, count } = fakeSignals();
    const getBackend = interruptible(async () => new FakeBackend(), {
      signals,
      stderr: new MemoryOutput(),
    });
    const backend = await getBackend();
    expect(await getBackend()).toBe(backend);
    expect(count('SIGINT')).toBe(0);
    const machine = await backend.create({ labels, idleTimeoutMs: 1 });
    expect([count('SIGINT'), count('SIGTERM'), count('SIGHUP')]).toEqual([1, 1, 1]);
    await machine.kill();
    expect(count('SIGINT')).toBe(0);
  });

  it('releases live machines on Ctrl-C, then exits 130', async () => {
    const inner = new FakeBackend();
    const { signals, send, exits, done } = fakeSignals();
    const stderr = new MemoryOutput();
    const backend = await interruptible(async () => inner, { signals, stderr })();
    await backend.create({ labels, idleTimeoutMs: 1 });
    send('SIGINT');
    await done;
    expect(inner.machines[0]?.killed).toBe(true);
    expect(exits).toEqual([130]);
    expect(stderr.text).toContain('twin: interrupted, releasing sbx_fake0 (Ctrl-C again to skip)');
    expect(stderr.text).toContain('twin: released sbx_fake0');
  });

  it('says so when a release is not confirmed, and a second Ctrl-C does not wait', async () => {
    const inner = new FakeBackend();
    const { signals, send, exits, done } = fakeSignals();
    const stderr = new MemoryOutput();
    const backend = await interruptible(async () => inner, { signals, stderr })();
    await backend.create({ labels, idleTimeoutMs: 1 });
    let finish: () => void = () => {};
    (inner.machines[0] as FakeMachine).kill = () =>
      new Promise<void>((_, reject) => {
        finish = () => reject(new Error('still running'));
      });
    send('SIGTERM');
    send('SIGINT');
    expect(exits).toEqual([143]);
    expect(stderr.text).toContain('twin: not waiting; stop sbx_fake0 with: twin stop');
    finish();
    await done;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stderr.text).toContain('could not confirm sbx_fake0 is gone; run: twin stop');
  });
});
