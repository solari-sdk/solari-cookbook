import { describe, it, expect } from "vitest";

import { createCheckRegistry, registry } from "../../src/checks/index.js";
import { fakeCheck } from "../fixtures/fake-check.js";

describe("ordering", () => {
  it("returns checks in registration order", () => {
    const r = createCheckRegistry([
      fakeCheck("gamma"),
      fakeCheck("alpha"),
      fakeCheck("beta"),
    ]);
    // Neither alphabetical nor costTier order; scheduling order is the
    // scheduler's concern (design.md §7).
    expect(r.ids()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("does not reorder by costTier — that is the scheduler's concern", () => {
    const r = createCheckRegistry([
      fakeCheck("expensive-one", { costTier: "expensive" }),
      fakeCheck("free-one", { costTier: "free" }),
    ]);
    expect(r.ids()).toEqual(["expensive-one", "free-one"]);
  });

  it("is stable across repeated calls", () => {
    const r = createCheckRegistry([fakeCheck("a"), fakeCheck("b")]);
    expect(r.ids()).toEqual(r.ids());
    expect(r.all()).toEqual(r.all());
  });

  it("cannot be mutated by a caller", () => {
    const r = createCheckRegistry([fakeCheck("a")]);
    expect(() => (r.all() as unknown as unknown[]).push(fakeCheck("b"))).toThrow();
    expect(r.ids()).toEqual(["a"]);
  });

  it("is unaffected by later mutation of the source array", () => {
    const source = [fakeCheck("a")];
    const r = createCheckRegistry(source);
    source.push(fakeCheck("sneaky"));
    expect(r.ids()).toEqual(["a"]);
  });
});

describe("duplicate ids", () => {
  it("fails loudly rather than silently overwriting", () => {
    expect(() =>
      createCheckRegistry([fakeCheck("auth"), fakeCheck("auth")]),
    ).toThrow(/Duplicate check id "auth"/);
  });

  it("rejects duplicates even when the two checks differ", () => {
    expect(() =>
      createCheckRegistry([
        fakeCheck("auth", { costTier: "free" }),
        fakeCheck("auth", { costTier: "expensive", description: "other" }),
      ]),
    ).toThrow(/Duplicate check id "auth"/);
  });

  it("names the offending id, so the failure is actionable", () => {
    expect(() =>
      createCheckRegistry([fakeCheck("a"), fakeCheck("b"), fakeCheck("b")]),
    ).toThrow(/"b"/);
  });
});

describe("empty registry", () => {
  it("is a valid state, not an error", () => {
    expect(() => createCheckRegistry([])).not.toThrow();
  });

  it("answers every query sensibly when empty", () => {
    const r = createCheckRegistry([]);
    expect(r.all()).toEqual([]);
    expect(r.ids()).toEqual([]);
    expect(r.get("auth")).toBeUndefined();
    expect(r.has("auth")).toBe(false);
  });

  it("the real registry holds only the checks that are built", () => {
    // Grows as modules 10-13 land; design.md §13 caps it at seven.
    expect(registry.ids()).toEqual([
      "auth",
      "sdk-version",
      "browser-lifecycle",
      "sandbox-command",
      "sandbox-cleanup",
      "session-liveness",
      "recording-lifecycle",
    ]);
    // design.md §13 caps v1 at seven. All seven are now present.
    expect(registry.ids()).toHaveLength(7);
  });
});

describe("lookup", () => {
  it("finds a registered check by id", () => {
    const auth = fakeCheck("auth");
    const r = createCheckRegistry([auth, fakeCheck("sdk-version")]);
    expect(r.get("auth")).toBe(auth);
    expect(r.has("sdk-version")).toBe(true);
  });

  it("reports an unknown id without throwing — `--explain` needs to say so", () => {
    const r = createCheckRegistry([fakeCheck("auth")]);
    expect(r.get("nope")).toBeUndefined();
    expect(r.has("nope")).toBe(false);
  });
});

describe("dependsOn validation (design.md §5)", () => {
  it("accepts a dependency that is registered", () => {
    expect(() =>
      createCheckRegistry([
        fakeCheck("auth"),
        fakeCheck("browser-lifecycle", { dependsOn: ["auth"] }),
      ]),
    ).not.toThrow();
  });

  it("rejects a dangling dependency, naming both checks", () => {
    expect(() =>
      createCheckRegistry([fakeCheck("browser-lifecycle", { dependsOn: ["auth"] })]),
    ).toThrow(/"browser-lifecycle" depends on "auth"/);
  });

  it("accepts a dependency declared later in the list", () => {
    // Registration order is not dependency order.
    expect(() =>
      createCheckRegistry([
        fakeCheck("browser-lifecycle", { dependsOn: ["auth"] }),
        fakeCheck("auth"),
      ]),
    ).not.toThrow();
  });

  it("treats a check with no dependsOn as having none", () => {
    expect(() => createCheckRegistry([fakeCheck("auth")])).not.toThrow();
  });
});
