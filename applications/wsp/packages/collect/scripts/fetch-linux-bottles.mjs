// SPDX-License-Identifier: AGPL-3.0-only
// Refreshes src/data/linux-bottles.ts from Homebrew's formula list. Runs
// against the built package, so `pnpm run bottles` builds first.
import { writeFile } from "node:fs/promises";
import { classifyFormulae, renderSnapshot } from "../dist/index.js";

const source = "https://formulae.brew.sh/api/formula.json";
const res = await fetch(source);
if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
const names = classifyFormulae(await res.json());
const fetched = new Date().toISOString().slice(0, 10);
await writeFile(new URL("../src/data/linux-bottles.ts", import.meta.url), renderSnapshot({ ...names, fetched, source }));
console.error(`${names.linux.length} formulae with a Linux bottle, ${names.noLinux.length} without, fetched ${fetched}`);
