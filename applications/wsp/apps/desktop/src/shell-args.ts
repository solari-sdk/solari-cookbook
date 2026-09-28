// SPDX-License-Identifier: AGPL-3.0-only
// What the main process tells a renderer before its page loads, one marker per fact: a sandboxed preload bundles
// all it imports, so the frame table and the app's own version stay in the main process and ride the argv.
const marker = (name: string): string => `--wsp-${name}=`;

export const shellArg = (name: string, value: string): string => `${marker(name)}${value}`;

export function shellArgFrom(argv: readonly string[], name: string): string | undefined {
  const mark = marker(name);
  return argv.find(a => a.startsWith(mark))?.slice(mark.length);
}
