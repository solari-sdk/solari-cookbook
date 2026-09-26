// SPDX-License-Identifier: AGPL-3.0-only
// The onboarding page is static html, so the mark it draws is a copy of the
// brand's; this pins the copy to the one path mark.svg owns.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the onboarding page's mark", () => {
  it("draws mark.svg's path", () => {
    const path = /<path d="([^"]+)"/.exec(read("../../web/src/brand/mark.svg"))?.[1];
    expect(path).toBeDefined();
    expect(read("../src/onboarding.html")).toContain(`<path d="${path}" />`);
  });
});
