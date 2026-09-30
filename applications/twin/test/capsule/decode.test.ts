import { describe, expect, it } from 'vitest';
import {
  array,
  boolean,
  integer,
  nullable,
  number,
  object,
  oneOf,
  optional,
  record,
  string,
} from '../../src/capsule/decode.ts';

describe('decoders', () => {
  it('accept matching primitives', () => {
    expect(string('x', 'p')).toBe('x');
    expect(boolean(false, 'p')).toBe(false);
    expect(number(1.5, 'p')).toBe(1.5);
    expect(integer(3, 'p')).toBe(3);
    expect(oneOf(['a', 'b'])('b', 'p')).toBe('b');
  });

  it('reject mismatches with the path and what was found', () => {
    expect(() => string(1, 'p.q')).toThrow('p.q: expected a string, got number 1');
    expect(() => number(Number.NaN, 'p')).toThrow('expected a number');
    expect(() => integer(1.5, 'p')).toThrow('expected an integer, got number 1.5');
    expect(() => boolean('true', 'p')).toThrow('got string "true"');
    expect(() => oneOf(['a'])('z', 'p')).toThrow('expected one of a');
  });

  it('compose for containers', () => {
    expect(array(integer)([1, 2], 'p')).toEqual([1, 2]);
    expect(() => array(integer)([1, 'x'], 'p')).toThrow('p[1]: expected an integer');
    expect(record(string)({ a: 'x' }, 'p')).toEqual({ a: 'x' });
    expect(() => record(string)({ a: 1 }, 'p')).toThrow('p.a: expected a string');
    expect(nullable(string)(null, 'p')).toBeNull();
    expect(optional(string)(undefined, 'p')).toBeUndefined();
  });

  it('omit undefined optional fields from decoded objects', () => {
    const decode = object<{ a: string; b?: string }>({ a: string, b: optional(string) });
    expect(decode({ a: 'x' }, 'p')).toEqual({ a: 'x' });
    expect(Object.keys(decode({ a: 'x', b: undefined }, 'p'))).toEqual(['a']);
  });
});
