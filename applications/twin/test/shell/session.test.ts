import { describe, expect, it } from 'vitest';
import { FakeTerminal } from '../../src/backend/fake.ts';
import { EXIT_MARKER } from '../../src/shell/guest.ts';
import { attach, DETACH_BYTE } from '../../src/shell/session.ts';
import { fakeLocal } from '../helpers/fakes.ts';

describe('attach', () => {
  it('forwards output and input until the guest shell exits', async () => {
    const remote = new FakeTerminal('/tmp/twin/shell.sh', 100, 30);
    const user = fakeLocal();
    const session = attach(remote, user.local);
    remote.emit('$ ');
    user.type('npm test\r');
    remote.emit('FAIL\r\n$ ');
    remote.emit(`exit\r\n${EXIT_MARKER}`);
    expect(await session).toBe('exited');
    expect(user.state.shown).toBe('$ FAIL\r\n$ exit\r\n');
    expect(remote.written).toEqual(['npm test\r']);
    expect(user.state.stopped).toBe(true);
    expect(remote.closed).toBe(true);
  });

  it('finds the exit marker split across chunks without showing any of it', async () => {
    const remote = new FakeTerminal('x', 80, 24);
    const user = fakeLocal();
    const session = attach(remote, user.local);
    remote.emit(`bye${EXIT_MARKER.slice(0, 4)}`);
    expect(user.state.shown).toBe('bye');
    remote.emit(EXIT_MARKER.slice(4));
    expect(await session).toBe('exited');
    expect(user.state.shown).toBe('bye');
  });

  it('releases held-back bytes that turn out not to be the marker', async () => {
    const remote = new FakeTerminal('x', 80, 24);
    const user = fakeLocal();
    const session = attach(remote, user.local);
    remote.emit('color \u001b');
    remote.emit('[31mred');
    expect(user.state.shown).toBe('color \u001b[31mred');
    user.press(DETACH_BYTE);
    await session;
  });

  it('detaches on Ctrl-] and forwards the keys typed before it', async () => {
    const remote = new FakeTerminal('x', 80, 24);
    const user = fakeLocal();
    const session = attach(remote, user.local);
    user.type(`ls\u001d`);
    expect(await session).toBe('detached');
    expect(remote.written).toEqual(['ls']);
    expect(remote.closed).toBe(true);
  });

  it('forwards resizes', async () => {
    const remote = new FakeTerminal('x', 80, 24);
    const user = fakeLocal();
    const session = attach(remote, user.local);
    user.resize(120, 40);
    user.press(DETACH_BYTE);
    await session;
    expect(remote.sizes).toEqual([
      [80, 24],
      [120, 40],
    ]);
  });
});
