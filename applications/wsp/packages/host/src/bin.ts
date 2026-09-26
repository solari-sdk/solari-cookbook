#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Executable entry only, nothing importable: index.ts re-exports from cli.ts,
// and sharing THIS module would send it into a tsup chunk whose top-level
// code never runs under `node bin.js`.
import { runBin } from "./entry.js";

runBin(process.argv.slice(2));
