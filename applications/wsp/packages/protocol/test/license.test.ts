// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./source-files.js";

const LICENSE_ID = "AGPL-3.0-only";
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

function manifests(): string[] {
  const out = ["package.json"];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      if (pkg.isDirectory() && existsSync(join(ROOT, top, pkg.name, "package.json"))) out.push(join(top, pkg.name, "package.json"));
    }
  }
  return out;
}

const PUBLIC_TEXT = ["README.md", "CONTRIBUTING.md", ...readdirSync(join(ROOT, "docs")).filter(f => f.endsWith(".md")).map(f => join("docs", f))];

describe("the license is one and the same everywhere", () => {
  it("LICENSE is the AGPL version 3 text", () => {
    const head = read("LICENSE").slice(0, 200);
    expect(head).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(head).toContain("Version 3");
  });

  it("every package.json names it", () => {
    const wrong = manifests().filter(rel => (JSON.parse(read(rel)) as { license?: string }).license !== LICENSE_ID);
    expect(wrong).toEqual([]);
  });

  it("the third-party notices name it and are pointed at from the README's license section", () => {
    expect(read("THIRD_PARTY_NOTICES")).toContain(LICENSE_ID);
    const licenseSection = read("README.md").split("\n## License\n")[1];
    expect(licenseSection).toBeDefined();
    expect(licenseSection).toContain(LICENSE_ID);
    expect(licenseSection).toContain("THIRD_PARTY_NOTICES");
  });

  it("CONTRIBUTING tells a contributor the license and the header new files carry", () => {
    const text = read("CONTRIBUTING.md");
    expect(text).toContain(LICENSE_ID);
    expect(text).toContain(`// SPDX-License-Identifier: ${LICENSE_ID}`);
  });
});

describe("the public text", () => {
  it("has no em-dash", () => {
    expect(PUBLIC_TEXT.filter(rel => read(rel).includes("\u2014"))).toEqual([]);
  });

  it("names the install command and the release page, not a package name npm gave to someone else", () => {
    const readme = read("README.md");
    const npm = (JSON.parse(read("packages/wspx/package.json")) as { name: string }).name;
    expect(readme).toContain(`npm i -g ${npm}\n`);
    // wsp and wsp-cli are someone else's on npm; nothing may send a reader to them.
    for (const taken of ["wsp", "wsp-cli"]) expect(readme).not.toMatch(new RegExp(`(npm i -g|npx) ${taken}(\\s|$)`, "m"));
    expect(readme).toContain("https://github.com/Zingzy/wsp/releases");
    expect(readme).toContain("https://github.com/Zingzy/wsp/issues");
  });
});
