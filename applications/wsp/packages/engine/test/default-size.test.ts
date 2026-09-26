// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, sourceFiles } from "../../protocol/test/source-files.js";

describe("one place for the size a machine is built at", () => {
  // A backend module owns the sizes of the machines it holds, and nothing else names one: each provider's table, the
  // module of a host with no provider, whose machines have no shape because there are none, the module for a
  // computer somebody owns, whose table offers no size either, since every machine it holds answers with its own,
  // and the module that answers out of memory, whose table is what a fixture's forks read as.
  const HOMES = ["solari-backend.ts", "docker-backend.ts", "box-backend.ts", "no-provider-backend.ts", "ssh-backend.ts", "fake-backend.ts"].map(f => join("packages", "engine", "src", f));
  // A vCPU count or a memory size written into a spec or a recipe; a road that names none takes pricing.defaultSize.
  const RULE = /\b(cpu|memMb):\s*\d/;

  it("no source file outside a backend's own table names a size", () => {
    const copies = sourceFiles().filter(rel => !HOMES.includes(rel) && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });
});
