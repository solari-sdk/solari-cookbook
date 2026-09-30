/** Keeps only the most recent output of a long-running command, bounded in memory. */
export class TailBuffer {
  readonly #maxChars: number;
  #text = '';

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  append(chunk: string): void {
    this.#text += chunk;
    // Trim lazily (at 2x) so appends stay amortized O(chunk).
    if (this.#text.length > this.#maxChars * 2) this.#text = this.#text.slice(-this.#maxChars);
  }

  /** The last `maxLines` lines within the character budget. */
  tail(maxLines: number): string {
    const lines = this.#text.slice(-this.#maxChars).split('\n');
    // A partial first line is an artifact of the character cut, not real output.
    if (this.#text.length > this.#maxChars) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-maxLines).join('\n');
  }
}
