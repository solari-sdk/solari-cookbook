// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { goldenName, nameOwner, projectSnapshotName } from "../src/snapshot-names.js";

describe("the mark wsp writes into a snapshot or template name", () => {
  it("a golden version's snapshot and its template read the same name, and the host reads back off it", () => {
    expect(goldenName("9f3a1c2b", "default", 1)).toBe("wsp-9f3a1c2b-default-v1");
    expect(goldenName("9f3a1c2b", "default", 12)).toBe("wsp-9f3a1c2b-default-v12");
    expect(nameOwner(goldenName("9f3a1c2b", "default", 12))).toBe("9f3a1c2b");
  });

  it("a project golden carries the project and the stamp behind the same mark", () => {
    expect(projectSnapshotName("h1", "spoo", "2026-09-08T10-00-00-000Z")).toBe("wsp-h1-project-spoo-2026-09-08T10-00-00-000Z");
    expect(nameOwner(projectSnapshotName("h1", "spoo", "2026-09-08T10-00-00-000Z"))).toBe("h1");
  });

  it("a golden or a project whose own name carries hyphens still reads back to the host that made it", () => {
    expect(nameOwner(goldenName("h1", "work-mac-2", 3))).toBe("h1");
    expect(nameOwner(projectSnapshotName("h1", "spoo-me", "s"))).toBe("h1");
  });

  it("a name without the mark has no owner, so nothing may claim it", () => {
    expect(nameOwner("golden-v1")).toBeUndefined();
    expect(nameOwner("project-spoo-latest")).toBeUndefined();
    expect(nameOwner("base")).toBeUndefined();
    expect(nameOwner("wsp-default-v1")).not.toBe("h1");
    expect(nameOwner(undefined)).toBeUndefined();
  });

  it("another host's name reads as that host, never as this one", () => {
    expect(nameOwner("wsp-zz9-default-v1")).toBe("zz9");
    expect(nameOwner(goldenName("zz9", "default", 1))).not.toBe("h1");
  });

  it("a host outside the class the provider takes is refused, rather than written into a name no parser reads back", () => {
    expect(() => goldenName("Mac.local", "default", 1)).toThrow(/lowercase letters and digits/);
    expect(() => goldenName("", "default", 1)).toThrow(/lowercase letters and digits/);
    expect(() => projectSnapshotName("mac local", "spoo", "s")).toThrow(/lowercase letters and digits/);
  });
});
