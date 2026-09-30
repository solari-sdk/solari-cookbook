/**
 * Minimal structural decoders for validating untrusted JSON (capsules come from issue attachments).
 * Kept in-house to stay dependency-free; each decoder either returns a typed value or throws a
 * DecodeError naming the exact path that failed.
 */

export class DecodeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'DecodeError';
    this.path = path;
  }
}

export type Decoder<T> = (value: unknown, path: string) => T;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`;
}

function expected(what: string, value: unknown, path: string): never {
  throw new DecodeError(path, `expected ${what}, got ${describe(value)}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const string: Decoder<string> = (value, path) =>
  typeof value === 'string' ? value : expected('a string', value, path);

export const boolean: Decoder<boolean> = (value, path) =>
  typeof value === 'boolean' ? value : expected('a boolean', value, path);

export const number: Decoder<number> = (value, path) =>
  typeof value === 'number' && Number.isFinite(value) ? value : expected('a number', value, path);

export const integer: Decoder<number> = (value, path) =>
  Number.isInteger(value) ? (value as number) : expected('an integer', value, path);

export function oneOf<const T extends string>(values: readonly T[]): Decoder<T> {
  return (value, path) =>
    values.includes(value as T)
      ? (value as T)
      : expected(`one of ${values.join(', ')}`, value, path);
}

export function nullable<T>(decoder: Decoder<T>): Decoder<T | null> {
  return (value, path) => (value === null ? null : decoder(value, path));
}

export function optional<T>(decoder: Decoder<T>): Decoder<T | undefined> {
  return (value, path) => (value === undefined ? undefined : decoder(value, path));
}

export function array<T>(item: Decoder<T>): Decoder<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return expected('an array', value, path);
    return value.map((entry, index) => item(entry, `${path}[${index}]`));
  };
}

export function record<T>(item: Decoder<T>): Decoder<Record<string, T>> {
  return (value, path) => {
    if (!isPlainObject(value)) return expected('an object', value, path);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, item(entry, `${path}.${key}`)]),
    );
  };
}

/** Decodes the listed fields. Unknown fields are dropped so newer minor additions stay readable. */
export function object<T>(shape: { [K in keyof T]-?: Decoder<T[K]> }): Decoder<T> {
  return (value, path) => {
    if (!isPlainObject(value)) return expected('an object', value, path);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      const decoded = shape[key](value[key], `${path}.${key}`);
      if (decoded !== undefined) out[key] = decoded;
    }
    return out as T;
  };
}
