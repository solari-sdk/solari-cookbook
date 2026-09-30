import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecodeError } from '../../src/capsule/decode.ts';
import {
  parseCapsule,
  readCapsule,
  serializeCapsule,
  writeCapsule,
} from '../../src/capsule/file.ts';
import { decodeCapsule } from '../../src/capsule/schema.ts';
import { TwinError } from '../../src/errors.ts';
import { makeCapsule } from '../helpers/capsule.ts';
import { useTempDirs } from '../helpers/fakes.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('decodeCapsule', () => {
  it('accepts a valid capsule unchanged', () => {
    const capsule = makeCapsule();
    expect(decodeCapsule(clone(capsule))).toEqual(capsule);
  });

  it('drops unknown fields so newer additive fields stay readable', () => {
    const raw = { ...clone(makeCapsule()), futureField: { x: 1 } };
    expect(decodeCapsule(raw)).not.toHaveProperty('futureField');
  });

  const decodeError = (raw: unknown): DecodeError => {
    try {
      decodeCapsule(raw);
    } catch (error) {
      if (error instanceof DecodeError) return error;
      throw error;
    }
    throw new Error('expected decodeCapsule to throw');
  };

  // Each case corrupts one field of a valid capsule, so the shape is loosely typed on purpose.
  type Bag = Record<string, unknown>;
  type Loose = Bag & { command: Bag; env: Bag; resolved: Bag };

  it.each<[string, (c: Loose) => void, string]>([
    ['command.exitCode', (c) => Object.assign(c.command, { exitCode: '1' }), 'expected an integer'],
    ['command.outcome', (c) => Object.assign(c.command, { outcome: 'maybe' }), 'one of pass, fail'],
    [
      'env.X.state',
      (c) => Object.assign(c.env, { X: { state: 'on' } }),
      'one of set, empty, absent',
    ],
    [
      'resolved.node.a[0]',
      (c) => Object.assign(c.resolved, { node: { a: [1] } }),
      'expected a string',
    ],
    ['repo', (c) => Object.assign(c, { repo: [] }), 'expected an object, got an array'],
    ['runtimes', (c) => Reflect.deleteProperty(c, 'runtimes'), 'got undefined'],
  ])('reports the failing path %s', (path, mutate, message) => {
    const raw = clone(makeCapsule()) as unknown as Loose;
    mutate(raw);
    const error = decodeError(raw);
    expect(error.path).toBe(`capsule.${path}`);
    expect(error.message).toContain(message);
  });

  it('rejects capsules from a newer format version with an upgrade hint', () => {
    expect(() => decodeCapsule({ ...clone(makeCapsule()), twin: 2 })).toThrow(/upgrade twin/);
  });

  it('rejects unsupported older versions', () => {
    expect(() => decodeCapsule({ ...clone(makeCapsule()), twin: 0 })).toThrow(
      /unsupported format v0/,
    );
  });

  it('rejects non-objects', () => {
    expect(() => decodeCapsule(null)).toThrow('capsule: expected an object, got null');
  });
});

describe('capsule files', () => {
  const tempDir = useTempDirs();

  it('round-trips through disk', async () => {
    const path = join(await tempDir(), 'c.json');
    const capsule = makeCapsule();
    const bytes = await writeCapsule(path, capsule);
    expect(bytes).toBe(Buffer.byteLength(serializeCapsule(capsule)));
    expect(await readCapsule(path)).toEqual(capsule);
  });

  it('explains a path that cannot be written', async () => {
    const path = join(await tempDir(), 'missing', 'c.json');
    await expect(writeCapsule(path, makeCapsule())).rejects.toThrow(/cannot write .*ENOENT/);
  });

  it('explains invalid JSON', () => {
    expect(() => parseCapsule('{nope', 'bad.json')).toThrow(TwinError);
    expect(() => parseCapsule('{nope', 'bad.json')).toThrow(/bad\.json is not valid JSON/);
  });

  it('explains schema errors with the path', () => {
    expect(() => parseCapsule('{"twin":1}', 'x.json')).toThrow(
      /x\.json is not a valid twin capsule \(capsule\.createdAt: expected a string/,
    );
  });

  it('explains missing files', async () => {
    const path = join(await tempDir(), 'missing.json');
    await expect(readCapsule(path)).rejects.toThrow(/cannot read .*missing\.json: ENOENT/);
  });

  it('serializes as pretty JSON with a trailing newline', () => {
    expect(serializeCapsule(makeCapsule())).toMatch(/^\{\n {2}"twin": 1,[\s\S]*\}\n$/);
  });
});
