import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sdkVersionCheck, compareVersions } from "../../src/checks/sdk-version.js";
import { createDoctorContext } from "../../src/context.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A project with `@solarisdk/browser` installed at a chosen version. */
function projectWith(manifest: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "sdk-version-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (manifest !== undefined) {
    const dir = join(root, "node_modules", "@solarisdk", "browser");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), manifest);
  }
  return root;
}

function runAt(projectRoot: string) {
  return sdkVersionCheck.run(createDoctorContext({ projectRoot }));
}

const at = (version: string) => JSON.stringify({ name: "@solarisdk/browser", version });

describe("check metadata", () => {
  it("is free and makes no network call", () => {
    expect(sdkVersionCheck.id).toBe("sdk-version");
    expect(sdkVersionCheck.costTier).toBe("free");
    expect(sdkVersionCheck.dependsOn).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("orders by numeric segment, not lexically", () => {
    expect(compareVersions("0.1.2", "0.1.3")).toBeLessThan(0);
    expect(compareVersions("0.1.10", "0.1.3")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.1.3")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.1.3")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("0.1.3", "0.1.3")).toBe(0);
  });

  it("pads missing segments with zero", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("0.2", "0.1.3")).toBeGreaterThan(0);
  });

  it("orders a prerelease before its release", () => {
    expect(compareVersions("0.1.3-beta.1", "0.1.3")).toBeLessThan(0);
    expect(compareVersions("0.1.4-rc.1", "0.1.3")).toBeGreaterThan(0);
  });

  it("returns NaN for anything it cannot parse", () => {
    expect(compareVersions("not-a-version", "0.1.3")).toBeNaN();
    expect(compareVersions("", "0.1.3")).toBeNaN();
    expect(compareVersions("0.1.3", "latest")).toBeNaN();
  });
});

describe("reads the user's project, not solari-doctor's own (§19.2)", () => {
  it("reports the fixture's version, which differs from the doctor's", async () => {
    const result = await runAt(projectWith(at("9.9.9-fixture")));

    expect(result.evidence).toMatchObject({ sdkVersion: "9.9.9-fixture" });
    // solari-doctor itself has 0.1.3 installed; if resolution leaked, this
    // would report that instead.
    expect(result.evidence).not.toMatchObject({ sdkVersion: "0.1.3" });
  });

  it("reports 0.1.2 as exposed even though the doctor runs 0.1.3", async () => {
    const result = await runAt(projectWith(at("0.1.2")));
    expect(result.status).toBe("warn");
    expect(result.evidence).toMatchObject({ sdkVersion: "0.1.2", exposed: true });
  });

  it("records the projectRoot it looked in when nothing was found", async () => {
    const root = projectWith(undefined);
    const result = await runAt(root);
    expect(result.evidence).toMatchObject({ projectRoot: root, resolved: false });
  });
});

describe("version outcomes (design.md §6.2)", () => {
  it("warns below 0.1.3 and cites the documented gotcha", async () => {
    const result = await runAt(projectWith(at("0.1.0")));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("older than 0.1.3");
    expect(result.remediation).toMatch(/solari\.close\(\)/);
    expect(result.issueRef).toBe("solari-cookbook#README-gotcha-1");
  });

  it("passes at exactly 0.1.3 — the boundary is inclusive", async () => {
    const result = await runAt(projectWith(at("0.1.3")));
    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ exposed: false });
  });

  it("passes above 0.1.3", async () => {
    expect((await runAt(projectWith(at("0.2.0")))).status).toBe("pass");
    expect((await runAt(projectWith(at("1.0.0")))).status).toBe("pass");
  });

  it("warns for a 0.1.3 prerelease, which does not contain the fix", async () => {
    const result = await runAt(projectWith(at("0.1.3-beta.1")));
    expect(result.status).toBe("warn");
  });

  it("never fails — a version read reports exposure, not an observed hang", async () => {
    for (const version of ["0.1.0", "0.1.2", "0.1.3", "2.0.0", "0.1.3-rc"]) {
      expect((await runAt(projectWith(at(version)))).status).not.toBe("fail");
    }
  });
});

describe("cannot determine", () => {
  it("warns when the package is not installed", async () => {
    const result = await runAt(projectWith(undefined));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("is not installed");
    // "could not tell" must never read as "you are safe".
    expect(result.status).not.toBe("pass");
  });

  it("warns when the manifest is not valid JSON", async () => {
    const result = await runAt(projectWith("{ not json"));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not valid JSON");
  });

  it("warns when the manifest declares no version", async () => {
    const result = await runAt(projectWith(JSON.stringify({ name: "@solarisdk/browser" })));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("declares no version");
  });

  it("warns when the version is not a string", async () => {
    const result = await runAt(projectWith('{"version": 113}'));
    expect(result.status).toBe("warn");
  });

  it("warns when the version is an empty string", async () => {
    const result = await runAt(projectWith(at("")));
    expect(result.status).toBe("warn");
  });

  it("warns when the version cannot be compared", async () => {
    const result = await runAt(projectWith(at("workspace:*")));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("unrecognised version");
    expect(result.evidence).toMatchObject({ comparable: false });
  });

  it("warns when projectRoot does not exist at all", async () => {
    const result = await runAt(join(tmpdir(), "definitely-not-a-real-project-dir"));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("is not installed");
  });
});

describe("the check never throws", () => {
  it("survives a directory where the manifest should be a file", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-version-odd-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // package.json as a directory: readFileSync fails with EISDIR, not ENOENT.
    mkdirSync(join(root, "node_modules", "@solarisdk", "browser", "package.json"), {
      recursive: true,
    });

    const result = await runAt(root);
    expect(result.status).toBe("warn");
    expect(result.id).toBe("sdk-version");
  });

  it("returns a result for every fixture shape", async () => {
    const shapes = [undefined, "", "{}", "[]", "null", '"a string"', at("0.1.2")];
    for (const shape of shapes) {
      await expect(runAt(projectWith(shape))).resolves.toMatchObject({
        id: "sdk-version",
      });
    }
  });
});
