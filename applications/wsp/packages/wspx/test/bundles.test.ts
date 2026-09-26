// SPDX-License-Identifier: AGPL-3.0-only
// One home for every download's name and for the URL that reaches it: the
// notes print them, the release job uploads under them, and the site links
// them. A second copy anywhere is a link that rots on the next release.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleEnv, bundleNames, downloadUrl, RELEASES, REPO, STABLE_NAMES } from "../scripts/bundles.mjs";

const script = fileURLToPath(new URL("../scripts/bundle-env.mjs", import.meta.url));

describe("what a release's downloads are called", () => {
  it("is one disk image for both mac chips and one AppImage for linux, each carrying the version", () => {
    expect(bundleNames("0.1.5")).toEqual({ mac: "wsp-0.1.5-mac.dmg", appImage: "wsp-0.1.5.AppImage" });
    expect(bundleNames("1.0.0-rc.1")).toEqual({ mac: "wsp-1.0.0-rc.1-mac.dmg", appImage: "wsp-1.0.0-rc.1.AppImage" });
  });

  it("has a copy of each under a name no version moves, of the same kind of file", () => {
    expect(STABLE_NAMES).toEqual({ mac: "wsp-mac.dmg", appImage: "wsp-linux.AppImage" });
    const versioned = bundleNames("0.1.5");
    for (const kind of ["mac", "appImage"] as const) {
      const suffix = (name: string) => name.slice(name.lastIndexOf("."));
      expect(suffix(STABLE_NAMES[kind])).toBe(suffix(versioned[kind]));
      expect(STABLE_NAMES[kind]).not.toContain("0.1.5");
    }
  });
});

describe("where a download is reached", () => {
  it("is the newest release's copy, which is the only link that survives a release", () => {
    expect(downloadUrl(STABLE_NAMES.mac)).toBe(`${REPO}/releases/latest/download/wsp-mac.dmg`);
    expect(downloadUrl(STABLE_NAMES.appImage)).toBe(`${REPO}/releases/latest/download/wsp-linux.AppImage`);
    expect(REPO).toBe("https://github.com/Zingzy/wsp");
  });

  it("has one page for anything with no single asset to point at, which the site's footer and the app's version line both read", () => {
    expect(RELEASES).toBe("https://github.com/Zingzy/wsp/releases");
  });
});

describe("the names the release job reads", () => {
  it("are the four assets it uploads, as the assignments a step appends to its environment", () => {
    expect(bundleEnv("0.1.5")).toBe("MAC_DMG=wsp-0.1.5-mac.dmg\nMAC_STABLE=wsp-mac.dmg\nAPPIMAGE=wsp-0.1.5.AppImage\nAPPIMAGE_STABLE=wsp-linux.AppImage\n");
  });

  it("come out of the script the workflow runs, for the version it is handed", () => {
    expect(execFileSync("node", [script, "0.1.5"], { encoding: "utf8" })).toBe(bundleEnv("0.1.5"));
  });
});
