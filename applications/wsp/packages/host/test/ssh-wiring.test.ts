// SPDX-License-Identifier: AGPL-3.0-only
// What this host wires for a machine it only reaches over ssh: the backend
// that dials it and the removal of what wsp put there, and nothing else.
import { describe, expect, it } from "vitest";
import { sshWiring } from "../src/cli.js";

describe("the wiring for the machines this computer reaches over ssh", () => {
  it("carries the backend that dials them and no road to a daemon on one", () => {
    expect(Object.keys(sshWiring()).sort()).toEqual(["backend", "removeDaemon"]);
  });
});
