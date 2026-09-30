/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const MIN_LENGTH = 32;
const MIN_BITS_PER_CHAR = 4.3;

/**
 * Heuristic for random-looking credentials that no specific rule caught. Requires mixed case and
 * digits, which excludes hex digests (git SHAs, checksums) and ordinary identifiers.
 */
export function looksLikeSecret(token: string): boolean {
  return (
    token.length >= MIN_LENGTH &&
    /[a-z]/.test(token) &&
    /[A-Z]/.test(token) &&
    /\d/.test(token) &&
    shannonEntropy(token) >= MIN_BITS_PER_CHAR
  );
}
