// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A fixture under daemon/fixtures at the repo root, where every daemon's tests read the same files. */
export const fixturePath = (name: string): string => fileURLToPath(new URL(`../../../daemon/fixtures/${name}`, import.meta.url));
export const fixture = (name: string): string => readFileSync(fixturePath(name), "utf8");
