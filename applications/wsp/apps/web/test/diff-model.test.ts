// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { toDiffModel } from "../src/diffs/model.js";

const PATCH = [
  "diff --git a/src/a.txt b/src/a.txt",
  "index 5626abf..f719efd 100644",
  "--- a/src/a.txt",
  "+++ b/src/a.txt",
  "@@ -1,2 +1,2 @@",
  "-one",
  "+two",
  " keep",
  "",
].join("\n");

describe("toDiffModel", () => {
  it("parses patches into keyed files and lists budget-cut files in the tree only", () => {
    const model = toDiffModel({ base: null, files: [{ path: "src/a.txt", patch: PATCH }, { path: "big.bin", patch: "" }], truncated: true }, "test");
    expect(model.raw).toBeNull();
    expect(model.files.map(f => f.filePath)).toEqual(["src/a.txt"]);
    expect(model.files[0]!.fileKey).toContain("src/a.txt");
    expect(model.stat).toEqual({ additions: 1, deletions: 1 });
    expect(model.changedFiles).toEqual([
      { path: "src/a.txt", kind: "modified", additions: 1, deletions: 1 },
      { path: "big.bin", kind: "modified", additions: 0, deletions: 0 },
    ]);
  });

  it("is empty for an empty reply", () => {
    const model = toDiffModel({ base: "main", files: [], truncated: false }, "test");
    expect(model.files).toEqual([]);
    expect(model.changedFiles).toEqual([]);
  });
});
