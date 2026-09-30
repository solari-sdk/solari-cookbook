import { describe, expect, it } from 'vitest';
import { FakeBackend, type FakeMachine } from '../../src/backend/fake.ts';
import { TrackedBackend } from '../../src/backend/tracked.ts';

const labels = { app: 'twin' };

function tracked(inner = new FakeBackend()) {
  const events: string[] = [];
  const backend = new TrackedBackend(inner, {
    onLive: () => events.push('live'),
    onIdle: () => events.push('idle'),
  });
  return { inner, backend, events };
}

describe('TrackedBackend', () => {
  it('tracks created machines until they are killed or kept', async () => {
    const { backend, events } = tracked();
    const a = await backend.create({ labels, idleTimeoutMs: 1 });
    const b = await backend.create({ labels, idleTimeoutMs: 1 });
    expect(backend.live).toEqual(['sbx_fake0', 'sbx_fake1']);
    expect(events).toEqual(['live']);
    await a.kill();
    expect(backend.live).toEqual(['sbx_fake1']);
    await b.detach();
    expect(backend.live).toEqual([]);
    expect(events).toEqual(['live', 'idle']);
  });

  it('delegates machine calls and backend queries', async () => {
    const inner = new FakeBackend((spec) =>
      spec.argv[0] === 'boom' ? { exitCode: 3 } : undefined,
    );
    const { backend } = tracked(inner);
    const machine = await backend.create({ labels, idleTimeoutMs: 1 });
    expect(backend.name).toBe('fake');
    expect((await machine.run({ argv: ['boom'], timeoutMs: 1 })).exitCode).toBe(3);
    await machine.writeFile('/a', 'b');
    expect(inner.machines[0]?.files.get('/a')).toBe('b');
    expect(await machine.previewUrl(80)).toContain('sbx_fake0-80');
    expect((await machine.openTerminal({ cols: 1, rows: 1, command: 'sh' })).close).toBeTypeOf(
      'function',
    );
    expect((await backend.list(labels)).map((m) => m.id)).toEqual(['sbx_fake0']);
    // Re-attached (kept) machines are not tracked: an interrupt leaves them running.
    await backend.connect('sbx_fake0');
    expect(await backend.reap(labels)).toEqual(['sbx_fake0']);
  });

  it('releases every live machine and reports ones it could not release', async () => {
    const { inner, backend } = tracked();
    await backend.create({ labels, idleTimeoutMs: 1 });
    await backend.create({ labels, idleTimeoutMs: 1 });
    const stuck = inner.machines[1] as FakeMachine;
    stuck.kill = async () => {
      throw new Error('still running');
    };
    expect(await backend.releaseAll()).toEqual({ released: ['sbx_fake0'], failed: ['sbx_fake1'] });
    expect(inner.machines[0]?.killed).toBe(true);
  });

  it('is live from the start of creation, and idle again if creation fails', async () => {
    const inner = new FakeBackend();
    const { backend, events } = tracked(inner);
    let fail: (error: Error) => void = () => {};
    inner.create = () =>
      new Promise((_, reject) => {
        fail = reject;
      });
    const creating = backend.create({ labels, idleTimeoutMs: 1 });
    expect(events).toEqual(['live']);
    fail(new Error('no capacity'));
    await expect(creating).rejects.toThrow('no capacity');
    expect(events).toEqual(['live', 'idle']);
  });

  it('waits for a machine still being created, then kills it', async () => {
    const { inner, backend } = tracked();
    const creating = backend.create({ labels, idleTimeoutMs: 1 });
    const release = backend.releaseAll();
    await expect(creating).rejects.toThrow('interrupted');
    expect(await release).toEqual({ released: ['sbx_fake0'], failed: [] });
    expect(inner.machines[0]?.killed).toBe(true);
    expect(backend.live).toEqual([]);
  });

  it('refuses new machines once released, and reports cut-short calls as interrupts', async () => {
    const { inner, backend } = tracked();
    const machine = await backend.create({ labels, idleTimeoutMs: 1 });
    await backend.releaseAll();
    await expect(backend.create({ labels, idleTimeoutMs: 1 })).rejects.toThrow('interrupted');
    expect(inner.machines).toHaveLength(1);
    await expect(machine.run({ argv: ['true'], timeoutMs: 1 })).rejects.toMatchObject({
      name: 'TwinError',
      exitCode: 130,
    });
  });
});
