// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { LINUX_BOTTLES, classifyFormulae, linuxSupport, renderSnapshot } from "../src/index.js";

const bottled = (files: string[]) => ({ bottle: { stable: { files: Object.fromEntries(files.map(f => [f, { url: "x" }])) } } });

const FORMULA_JSON = [
  { name: "jq", ...bottled(["arm64_sequoia", "x86_64_linux"]) },
  { name: "gh", ...bottled(["arm64_sequoia", "arm64_linux"]) },
  { name: "ca-certificates", ...bottled(["all"]) },
  { name: "mas", ...bottled(["arm64_sequoia", "sonoma"]) },
  { name: "afsctool", bottle: {} },
  { name: "brightness" },
  { name: "python@3.12", ...bottled(["x86_64_linux"]) },
];

const SNAPSHOT = { fetched: "2026-09-03", source: "https://example.test/formula.json", linux: ["gh", "jq"], noLinux: ["mas"] };

describe("brew bottles", () => {
  it("splits formulae by whether any bottle runs on Linux, sorted by name", () => {
    expect(classifyFormulae(FORMULA_JSON)).toEqual({
      linux: ["ca-certificates", "gh", "jq", "python@3.12"],
      noLinux: ["afsctool", "brightness", "mas"],
    });
  });

  it("ignores anything that is not a formula list", () => {
    expect(classifyFormulae("nope")).toEqual({ linux: [], noLinux: [] });
    expect(classifyFormulae([{ nope: 1 }, null, 4])).toEqual({ linux: [], noLinux: [] });
  });

  it("renders a snapshot as a generated source file carrying the fetch date, one name per line", () => {
    const src = renderSnapshot(SNAPSHOT);
    expect(src).toContain("// SPDX-License-Identifier: AGPL-3.0-only");
    expect(src).toContain('fetched: "2026-09-03"');
    expect(src).toContain('source: "https://example.test/formula.json"');
    expect(src).toMatch(/linux: \[\n {4}"gh",\n {4}"jq",\n {2}\]/);
    expect(src).toMatch(/noLinux: \[\n {4}"mas",\n {2}\]/);
  });

  it.each([
    ["jq", "yes"],
    ["mas", "no"],
    ["oven-sh/bun/bun", "unknown"],
    ["brand-new-formula", "unknown"],
  ])("%s -> %s", (name, want) => {
    expect(linuxSupport(name, SNAPSHOT)).toBe(want);
  });

  it("the checked-in snapshot is dated, disjoint and knows the everyday formulae", () => {
    expect(LINUX_BOTTLES.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(LINUX_BOTTLES.source).toBe("https://formulae.brew.sh/api/formula.json");
    expect(LINUX_BOTTLES.linux.length).toBeGreaterThan(5000);
    const linux = new Set(LINUX_BOTTLES.linux);
    expect(LINUX_BOTTLES.noLinux.some(n => linux.has(n))).toBe(false);
    expect(linuxSupport("gh")).toBe("yes");
    expect(linuxSupport("jq")).toBe("yes");
    expect(linuxSupport("mas")).toBe("no");
    expect(linuxSupport("pinentry-mac")).toBe("no");
  });
});
