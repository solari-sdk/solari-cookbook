import { looksLikeSecret } from './entropy.ts';

/** Bump whenever rules change so a capsule records which rule set scrubbed it. */
export const RULES_VERSION = 2;

export interface SecretRule {
  id: string;
  /** Must carry the `g` flag. */
  pattern: RegExp;
  /**
   * Replacement for one match. Returns null to leave the match untouched (not counted).
   * Defaults to replacing the whole match with a marker.
   */
  replace?: (match: string, groups: Partial<Record<string, string>>) => string | null;
}

export function marker(id: string): string {
  return `<redacted:${id}>`;
}

/**
 * Ordered from most to least specific: earlier rules replace text with markers that later, more
 * generic rules cannot match again.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    // A key cut in half: an output tail that lost the BEGIN line, or output that ends mid-key.
    id: 'private-key',
    pattern:
      /(?:^[A-Za-z0-9+/=]+\r?\n)+-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/gm,
  },
  {
    id: 'url-credentials',
    pattern: /\b(?<scheme>[a-z][a-z0-9+.-]*:\/\/)(?<userinfo>[^\s/@:]+(?::[^\s/@]*)?)@/gi,
    replace: (_match, { scheme }) => `${scheme}${marker('url-credentials')}@`,
  },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  { id: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'solari-key', pattern: /\bslr_(?:live|test)_[A-Za-z0-9_-]{8,}/g },
  { id: 'llm-api-key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'bearer-token',
    pattern: /\b(?<scheme>Bearer|Basic|Token)\s+(?<token>[A-Za-z0-9._~+/-]{8,}=*)/g,
    replace: (_match, { scheme }) => `${scheme} ${marker('bearer-token')}`,
  },
  {
    // KEY=value, "key": "value", password: value. Keeps the name, drops the value.
    id: 'assignment',
    pattern:
      /(?<name>\b[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(?<sep>["']?\s*[:=]\s*)(?:(?<quote>["'])(?<quoted>(?:(?!\k<quote>)[^\r\n]){4,})\k<quote>|(?<open>["']?)(?<value>[^\s"'<>,;]{4,})(?![^\s"'<>,;]))(?!\s+<redacted:)/gi,
    // A quoted value is dropped whole, spaces and punctuation included, so no tail of it survives.
    // The lookaheads stop "Authorization: Bearer <redacted:...>" from being redacted twice.
    replace: (match, { name, sep, quote, quoted, open, value }) => {
      if (quoted !== undefined) {
        return quoted.includes('<redacted:')
          ? match
          : `${name}${sep}${quote}${marker('assignment')}${quote}`;
      }
      return value?.startsWith('<redacted:')
        ? match
        : `${name}${sep}${open}${marker('assignment')}`;
    },
  },
  {
    // Env-style *_KEY variables (SECRET_KEY_BASE aside, e.g. ENCRYPTION_KEY, SIGNING_KEY) often hold
    // hex, which the high-entropy rule skips because hex digests are usually public.
    id: 'assignment',
    pattern: /\b(?<name>[A-Z][A-Z0-9_]*_KEY)(?<sep>\s*=\s*)(?<quote>["']?)(?<value>[^\s"']{8,})/g,
    replace: (match, { name, sep, quote, value }) =>
      value?.startsWith('<redacted:') ? match : `${name}${sep}${quote}${marker('assignment')}`,
  },
  {
    // Integrity hashes (sha512-...) in lockfile diffs are public and needed to apply the diff.
    id: 'high-entropy',
    pattern: /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{32,}/g,
    replace: (match) =>
      !/^sha(?:1|256|384|512)-/.test(match) && looksLikeSecret(match)
        ? marker('high-entropy')
        : null,
  },
];
