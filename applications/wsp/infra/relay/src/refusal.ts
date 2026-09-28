// SPDX-License-Identifier: AGPL-3.0-only
// One refusal shape for every route: the status the person or the command line
// reads, and one sentence saying what to do about it.

export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The codes somebody else's API gave for it, when it came from one: a caller that acts on a particular
     * refusal reads the code and never the sentence, which is theirs to reword and may quote another code. */
    readonly codes: readonly number[] = [],
  ) {
    super(message);
  }
}

export const refuse = (status: number, message: string, codes: readonly number[] = []): Refusal => new Refusal(status, message, codes);
