import observation from "./observation.cjs";
export const { observe, checkpoint, reopen, takeover } = observation;
export function parseCheckpoint(raw: string) {
  if (Buffer.byteLength(raw) > 524288) throw Error("CHECKPOINT_LIMIT");
  const value = JSON.parse(raw);
  reopen(value);
  return value;
}
