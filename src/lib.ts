export function round(ms: number): number {
  return Math.round(ms);
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
