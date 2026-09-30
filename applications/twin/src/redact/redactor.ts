import { SECRET_RULES, type SecretRule } from './rules.ts';

export interface RedactorOptions {
  /** Absolute home directory; occurrences are rewritten to `~`. */
  homeDir?: string;
  rules?: readonly SecretRule[];
}

const HOME_RULE_ID = 'home-path';

// Other users' home directories in paths also identify people; collapse them too.
const GENERIC_HOME = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^/\\\s:'"]+/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrubs secrets and personal paths from any text that ends up in a capsule, and tallies what it
 * replaced so the capsule (and the reporter's preview) can say so.
 */
export class Redactor {
  readonly #rules: readonly SecretRule[];
  readonly #home: RegExp | null;
  readonly #counts = new Map<string, number>();

  constructor(options: RedactorOptions = {}) {
    this.#rules = options.rules ?? SECRET_RULES;
    const home = options.homeDir?.replace(/[/\\]+$/, '');
    // A root-ish home (e.g. "/" in containers) would rewrite every path.
    this.#home =
      home && home.length > 1 ? new RegExp(`${escapeRegExp(home)}(?=[/\\\\]|\\b|$)`, 'g') : null;
  }

  scrub(text: string): string {
    let out = text;
    for (const rule of this.#rules) out = this.#apply(out, rule);
    return this.#scrubHome(out);
  }

  /** Replacement counts per rule id since this redactor was created. */
  counts(): Record<string, number> {
    return Object.fromEntries([...this.#counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /** Total replacements excluding home-path rewrites, i.e. suspected secrets. */
  secretCount(): number {
    let total = 0;
    for (const [id, count] of this.#counts) if (id !== HOME_RULE_ID) total += count;
    return total;
  }

  #apply(text: string, rule: SecretRule): string {
    return text.replace(rule.pattern, (match: string, ...args: unknown[]) => {
      const last = args.at(-1);
      const groups =
        typeof last === 'object' && last !== null ? (last as Partial<Record<string, string>>) : {};
      const replacement = rule.replace ? rule.replace(match, groups) : `<redacted:${rule.id}>`;
      if (replacement === null || replacement === match) return match;
      this.#bump(rule.id);
      return replacement;
    });
  }

  #scrubHome(text: string): string {
    let out = text;
    if (this.#home) out = out.replace(this.#home, () => this.#bumped('~'));
    return out.replace(GENERIC_HOME, () => this.#bumped('~'));
  }

  #bumped(replacement: string): string {
    this.#bump(HOME_RULE_ID);
    return replacement;
  }

  #bump(id: string): void {
    this.#counts.set(id, (this.#counts.get(id) ?? 0) + 1);
  }
}
