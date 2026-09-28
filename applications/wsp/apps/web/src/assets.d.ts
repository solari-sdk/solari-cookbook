// SPDX-License-Identifier: AGPL-3.0-only
// Vite 5 types know "*?url" but not the "&no-inline" flag the ghostty runtime
// adds for its trampoline; the flag is ignored here and the import still yields a URL.
declare module "*?url&no-inline" {
  const src: string;
  export default src;
}
