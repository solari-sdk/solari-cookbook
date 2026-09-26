// SPDX-License-Identifier: AGPL-3.0-only
// A markdown file imports as its text: tsup and the desktop bundle inline it at build time, vitest's md-text plugin does the same.
declare module "*.md" {
  const text: string;
  export default text;
}
