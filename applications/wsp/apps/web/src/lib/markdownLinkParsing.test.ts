// Adapted from pingdotgg/t3code packages/client-runtime/src/markdownLinks.test.ts at 57a66608 (MIT).
// Differs from upstream: the "label:digits is not a file" case uses NOTE:12 instead of the to-do marker upstream used.
import { describe, expect, it } from "vitest";

import { inlineCodeFilePathCandidate, isConventionalFilePosition } from "./markdownLinkParsing";

describe("inlineCodeFilePathCandidate", () => {
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["C:\\Users\\demo\\image.png", "C:\\Users\\demo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["script.pl:10", "script.pl:10"],
    ["node.meta", null],
    ["Recorded evidence here: /tmp/image.png", null],
    ["origin/main", null],
    ["127.0.0.1:3000", null],
    ["example.com/index.html", null],
    ["example.pl/index.html", null],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("isConventionalFilePosition", () => {
  it("distinguishes extensionless file locations from labels and ports", () => {
    expect(isConventionalFilePosition("Dockerfile:8:2")).toBe(true);
    expect(isConventionalFilePosition("Makefile")).toBe(false);
    expect(isConventionalFilePosition("NOTE:12")).toBe(false);
    expect(isConventionalFilePosition("port:3000")).toBe(false);
  });
});
