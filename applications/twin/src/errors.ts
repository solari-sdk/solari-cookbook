/** An expected failure whose message is meant for the user, printed without a stack trace. */
export class TwinError extends Error {
  readonly exitCode: number;

  constructor(message: string, options: { exitCode?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'TwinError';
    this.exitCode = options.exitCode ?? 1;
  }
}
