// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latestFlag } from "../scripts/latest-flag.mjs";

const script = fileURLToPath(new URL("../scripts/latest-flag.mjs", import.meta.url));

describe("which release GitHub is told to serve as latest", () => {
  it("takes a version above the one served today, and the first release of all", () => {
    expect(latestFlag("v0.3.0", "v0.2.0")).toBe("--latest");
    expect(latestFlag("v0.2.1", "v0.2.0")).toBe("--latest");
    expect(latestFlag("v1.0.0", "v0.9.9")).toBe("--latest");
    expect(latestFlag("v0.1.0", "")).toBe("--latest");
  });

  it("takes an equal tag, so a rerun of the job that publishes never demotes what it published", () => {
    expect(latestFlag("v0.2.0", "v0.2.0")).toBe("--latest");
  });

  it("leaves a lower version published and the download names where they are", () => {
    expect(latestFlag("v0.1.9", "v0.2.0")).toBe("--latest=false");
    expect(latestFlag("v0.1.9", "v0.1.10")).toBe("--latest=false");
  });

  it("publishes a prerelease as one, whatever number it carries", () => {
    expect(latestFlag("v0.3.0-rc.1", "v0.2.0")).toBe("--latest=false --prerelease");
    expect(latestFlag("v9.9.9-alpha.1", "")).toBe("--latest=false --prerelease");
    expect(latestFlag("v0.2.0-rc.1", "v0.2.0")).toBe("--latest=false --prerelease");
  });

  it("refuses a ref that is no release tag rather than guessing at its order", () => {
    expect(() => latestFlag("preview", "v0.2.0")).toThrow(/not a release tag/);
    expect(() => latestFlag("v0.2.0", "preview")).toThrow(/not a release tag/);
  });

  it("prints the flags on its own, which is how the job that publishes reads them", () => {
    const said = execFileSync("node", [script, "v0.3.0-rc.1", "v0.2.0"], { encoding: "utf8" });
    expect(said.trim()).toBe("--latest=false --prerelease");
    expect(execFileSync("node", [script, "v0.3.0", ""], { encoding: "utf8" }).trim()).toBe("--latest");
  });
});
