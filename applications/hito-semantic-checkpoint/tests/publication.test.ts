import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import publication from "../src/publication-scan.cjs";
test("exact selected publication files pass secret and private-path census", () => {
  const result = publication.scan(new URL("../", import.meta.url));
  assert.equal(result.status, "PASS", JSON.stringify(result.findings));
  assert(result.files.length > 20);
  assert(
    result.files.every(
      (f: any) => f.classification === "ORIGINAL_HITO_SOLARI_CONTRIBUTION",
    ),
  );
});
test("scanner fails closed on synthetic credential without returning it", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-test-"));
  try {
    const fake = ["slr", "live", "X".repeat(32)].join("_");
    writeFileSync(join(root, "README.md"), fake);
    const result = publication.scan(root);
    assert.equal(result.status, "FAIL");
    assert(!JSON.stringify(result).includes(fake));
    assert(result.findings.some((x: any) => x.category === "PROVIDER_SECRET"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("unrecognized publication files fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-test-"));
  try {
    writeFileSync(join(root, "unreviewed.txt"), "unknown provenance");
    assert.equal(publication.scan(root).status, "FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("drive paths are blocked while HTTPS references remain allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-test-"));
  try {
    writeFileSync(
      join(root, "README.md"),
      ["Z", ":", "/", "private", "/", "project"].join(""),
    );
    assert.equal(publication.scan(root).status, "FAIL");
    writeFileSync(
      join(root, "README.md"),
      "https://example.invalid/documentation",
    );
    assert.equal(publication.scan(root).status, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("historical summaries have exact artifact hashes and bounded nonclaims", () => {
  for (const name of ["R1", "R1C", "R2"]) {
    const x = JSON.parse(
      readFileSync(
        new URL("../evidence/" + name + "_SUMMARY.json", import.meta.url),
        "utf8",
      ),
    );
    assert(x.question && x.negativeResult && x.doesNotProve.length);
    assert(
      x.sources.every(
        (s: any) => /^[a-f0-9]{64}$/.test(s.sha256) && !s.path.includes(":"),
      ),
    );
    assert(
      x.evidence.every(
        (e: any) =>
          x.sources.some(
            (s: any) => s.id === e.sourceId && s.sha256 === e.sourceSha256,
          ) && e.pointer.startsWith("#"),
      ),
    );
  }
});
test("application license is scoped and dependencies have permissive provenance", () => {
  const notice = readFileSync(
    new URL("../THIRD_PARTY_NOTICES.md", import.meta.url),
    "utf8",
  );
  assert.match(notice, /not vendored/);
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  for (const [name, entry] of Object.entries<any>(lock.packages)) {
    if (!name) continue;
    assert(
      ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"].includes(entry.license),
      name,
    );
    assert(entry.resolved.startsWith("https://registry.npmjs.org/"));
  }
});
