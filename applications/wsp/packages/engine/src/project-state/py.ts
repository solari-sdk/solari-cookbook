// SPDX-License-Identifier: AGPL-3.0-only
// The lines every python3 script a module hands the machine opens with.
// Nothing on the machine can run the engine, so the listing that names a
// project's paths and the merge that folds its rows in both carry their values
// and the one rule for a path at the project or under it as python text.

/** A python expression for any JSON value, carried as base64 so no byte of a path or a row needs escaping. */
export const pyData = (value: unknown): string => `data(${JSON.stringify(Buffer.from(JSON.stringify(value), "utf8").toString("base64"))})`;

/** The imports both scripts draw on, data() for the values their steps carry, under() for the path rule (a recorded
 * path is the project's when it is the path itself or a folder under it, which is what the listing keeps and what the
 * merge rewrites) and q() for a table or column name in the SQL a step builds. */
export const PY_PREAMBLE = [
  "import base64, json, os, re, shutil, sqlite3, sys, urllib.parse",
  "def data(b):",
  "    return json.loads(base64.b64decode(b))",
  "def under(p, root):",
  '    return p == root or p.startswith(root + "/")',
  "def q(name):",
  "    return '\"' + name.replace('\"', '\"\"') + '\"'",
].join("\n");
