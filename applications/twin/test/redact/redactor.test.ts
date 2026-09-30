import { describe, expect, it } from 'vitest';
import { looksLikeSecret, shannonEntropy } from '../../src/redact/entropy.ts';
import { Redactor } from '../../src/redact/redactor.ts';

// Fake credentials are assembled at runtime so secret scanners do not flag this file.
const join = (...parts: string[]) => parts.join('');
const RANDOM = 'q7Xk2LmP9vR4tZ8wB3nC6yH1jD5fG0sA';

describe('Redactor secret rules', () => {
  const cases: [rule: string, secret: string][] = [
    ['github-token', join('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')],
    ['github-token', join('github', '_pat_', 'x'.repeat(40))],
    ['aws-access-key', join('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
    ['slack-token', join('xo', 'xb-', '1234567890-abcdef')],
    ['stripe-key', join('sk', '_live_', 'abcdefghijklmnop1234')],
    ['google-api-key', join('AI', 'za', 'A'.repeat(35))],
    ['npm-token', join('np', 'm_', 'a'.repeat(36))],
    ['solari-key', join('slr', '_live_', 'abcdef123456')],
    ['llm-api-key', join('sk', '-ant-', 'api03-abcdefghijklmnopqrstuv')],
    [
      'jwt',
      join('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'dozjgNryP4J3jVmNHl0w5N'),
    ],
    ['gitlab-token', join('gl', 'pat-', 'abcdefghij1234567890')],
  ];

  it.each(cases)('replaces %s', (rule, secret) => {
    const redactor = new Redactor();
    const out = redactor.scrub(`value: ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain(`<redacted:${rule}>`);
    expect(redactor.counts()[rule]).toBe(1);
  });

  it('keeps the name of assigned secrets but drops the value', () => {
    const redactor = new Redactor();
    expect(redactor.scrub('DB_PASSWORD=hunter2 next')).toBe(
      'DB_PASSWORD=<redacted:assignment> next',
    );
    expect(redactor.scrub('{"apiKey": "abcd1234"}')).toBe('{"apiKey": "<redacted:assignment>"}');
  });

  it('strips credentials from URLs but keeps the host', () => {
    const out = new Redactor().scrub('fetch https://bob:s3cret@registry.example.com/pkg');
    expect(out).toBe('fetch https://<redacted:url-credentials>@registry.example.com/pkg');
  });

  it('replaces bearer tokens after the scheme', () => {
    const out = new Redactor().scrub('Authorization: Bearer abc.def.ghi-123');
    expect(out).toContain('Bearer <redacted:bearer-token>');
    expect(out).not.toContain('abc.def.ghi-123');
  });

  it('removes whole private key blocks', () => {
    const block = join(
      '-----BEGIN ',
      'RSA PRIVATE KEY-----\nMIIE\n-----END ',
      'RSA PRIVATE KEY-----',
    );
    expect(new Redactor().scrub(`a\n${block}\nb`)).toBe('a\n<redacted:private-key>\nb');
  });

  it('catches random-looking tokens that no specific rule knows', () => {
    const out = new Redactor().scrub(`token ${RANDOM}`);
    expect(out).toBe('token <redacted:high-entropy>');
  });

  it('leaves ordinary output alone', () => {
    const redactor = new Redactor();
    const text = [
      'commit 3f2a9c8d1e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b',
      '"integrity": "sha512-q7Xk2LmP9vR4tZ8wB3nC6yH1jD5fG0sAq7Xk2LmP9vR4tZ8w=="',
      'FAIL src/components/SomeVeryLongComponentName.test.tsx',
      'expected 1 to be 2',
    ].join('\n');
    expect(redactor.scrub(text)).toBe(text);
    expect(redactor.secretCount()).toBe(0);
  });
});

describe('Redactor home paths', () => {
  it('rewrites the given home directory to ~', () => {
    const redactor = new Redactor({ homeDir: '/home/alice/' });
    expect(redactor.scrub('at /home/alice/project/a.js:1')).toBe('at ~/project/a.js:1');
    expect(redactor.counts()).toEqual({ 'home-path': 1 });
    expect(redactor.secretCount()).toBe(0);
  });

  it('does not touch a longer sibling directory name', () => {
    const redactor = new Redactor({ homeDir: '/opt/al' });
    expect(redactor.scrub('/opt/alpha/x')).toBe('/opt/alpha/x');
  });

  it('collapses other users home directories too', () => {
    const redactor = new Redactor({ homeDir: '/home/alice' });
    expect(redactor.scrub('/Users/bob/x and /home/carol/y and C:\\Users\\dan\\z')).toBe(
      '~/x and ~/y and ~\\z',
    );
  });

  it('ignores a root home directory', () => {
    expect(new Redactor({ homeDir: '/' }).scrub('/usr/bin/node')).toBe('/usr/bin/node');
  });
});

describe('entropy', () => {
  it('computes bits per character', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });

  it('requires length, mixed character classes and high entropy', () => {
    expect(looksLikeSecret(RANDOM)).toBe(true);
    expect(looksLikeSecret(RANDOM.slice(0, 20))).toBe(false);
    expect(looksLikeSecret('3f2a9c8d1e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b')).toBe(false);
    expect(looksLikeSecret('AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA1')).toBe(false);
  });
});

describe('redaction gaps', () => {
  const scrub = (text: string) => new Redactor().scrub(text);

  it('drops a quoted secret whole, spaces and punctuation included', () => {
    expect(scrub('password: "hunter2 is, great"')).toBe('password: "<redacted:assignment>"');
  });

  it('drops hex values of env-style *_KEY variables', () => {
    expect(scrub(`ENCRYPTION_KEY=${'0123456789abcdef'.repeat(2)}`)).toBe(
      'ENCRYPTION_KEY=<redacted:assignment>',
    );
  });

  it('drops a private key whose BEGIN line was cut off by the output tail', () => {
    const end = ['-----END', 'PRIVATE KEY-----'].join(' ');
    expect(scrub(`MIIEvQIBADANBgkqhkiG9w0BAQEF\nab+/==\n${end}\nnext`)).toBe(
      '<redacted:private-key>\nnext',
    );
  });
});
