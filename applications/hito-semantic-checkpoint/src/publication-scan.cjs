"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { fileURLToPath } = require("node:url");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const TOP = new Set([
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".env.example",
  ".gitignore",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
]);
const KNOWN = new Set([
  ...TOP,
  ...[
    "index.ts",
    "solari.ts",
    "checkpoint.ts",
    "takeover.ts",
    "receipt.ts",
    "types.ts",
    "hito-observation.cjs",
    "observation.cjs",
    "guest.cjs",
    "publication-scan.cjs",
  ].map((n) => "src/" + n),
  "tests/application.test.ts",
  "tests/publication.test.ts",
  ...[
    "architecture.md",
    "public-subset.md",
    "evidence-boundary.md",
    "solari-opportunity.md",
  ].map((n) => "docs/" + n),
  ...[
    "README.md",
    "R1_SUMMARY.json",
    "R1C_SUMMARY.json",
    "R2_SUMMARY.json",
  ].map((n) => "evidence/" + n),
  ...["same-state", "changed-state"].flatMap((d) =>
    ["README.md", "package.json", "src/index.js"].map(
      (n) => "fixtures/" + d + "/" + n,
    ),
  ),
]);
function scan(root) {
  root = root instanceof URL ? fileURLToPath(root) : root;
  const files = [],
    findings = [];
  function walk(dir, rel = "") {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = rel ? rel + "/" + e.name : e.name;
      const location = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        findings.push({ path: name, category: "LINK_FORBIDDEN" });
        continue;
      }
      if (e.isDirectory()) {
        if (!rel && ["node_modules", "runs"].includes(e.name)) continue;
        if (
          !rel &&
          !["src", "tests", "fixtures", "docs", "evidence"].includes(e.name)
        ) {
          findings.push({ path: name, category: "UNEXPECTED_DIRECTORY" });
          continue;
        }
        if (
          e.name.startsWith(".") ||
          ["node_modules", "dist", "build", "backup", "tmp"].includes(e.name)
        ) {
          findings.push({
            path: name,
            category: "PRIVATE_OR_GENERATED_DIRECTORY",
          });
          continue;
        }
        walk(location, name);
        continue;
      }
      if (!e.isFile()) {
        findings.push({ path: name, category: "SPECIAL_FILE" });
        continue;
      }
      if (!KNOWN.has(name)) {
        findings.push({ path: name, category: "UNKNOWN_PROVENANCE" });
        continue;
      }
      if (
        (!rel && !TOP.has(e.name)) ||
        (rel && !/\.(ts|cjs|js|json|md)$/.test(e.name)) ||
        (e.name.startsWith(".env") && name !== ".env.example") ||
        /(auth|credential|cookie|backup|\.bak|\.tmp)/i.test(e.name)
      ) {
        findings.push({ path: name, category: "UNEXPECTED_OR_PRIVATE_FILE" });
        continue;
      }
      const bytes = fs.readFileSync(location);
      if (bytes.length > 524288) {
        findings.push({ path: name, category: "OVERSIZED_PUBLIC_FILE" });
        continue;
      }
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) {
        findings.push({ path: name, category: "NON_UTF8_CONTENT" });
        continue;
      }
      const checks = [
        [
          "PROVIDER_SECRET",
          /(?:slr_live_|sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
        ],
        [
          "PRIVATE_ABSOLUTE_PATH",
          /\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_-]+\\|\/(?:Users|home)\/[A-Za-z0-9_.-]+\//,
        ],
        ["PERSONAL_EMAIL", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
        [
          "GENERIC_SECRET_ASSIGNMENT",
          /(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
        ],
      ];
      for (const [category, pattern] of checks)
        if (pattern.test(text)) findings.push({ path: name, category });
      if (name === ".env.example" && text !== "SOLARI_API_KEY=\n")
        findings.push({ path: name, category: "ENV_EXAMPLE_NOT_EMPTY" });
      files.push({
        path: name,
        bytes: bytes.length,
        sha256: sha(bytes),
        classification: "ORIGINAL_HITO_SOLARI_CONTRIBUTION",
      });
    }
  }
  walk(root);
  return {
    status: findings.length ? "FAIL" : "PASS",
    files,
    findings,
    scope:
      "Exact selected application source set; node_modules and runs are excluded from publication. Pattern/path/allowlist scan, not a proof of absence of every possible secret.",
  };
}
module.exports = { scan };
