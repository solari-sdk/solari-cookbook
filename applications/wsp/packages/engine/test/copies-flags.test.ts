// SPDX-License-Identifier: AGPL-3.0-only
// What every computer wsp can run a workspace on declares about copies: that it
// makes a workspace by copying itself with the project inside, and whether a
// copy gets a network of its own. One case over every backend module, so a
// provider added without an answer to both is a failure here rather than a row
// that reads as false.
import { describe, expect, it } from "vitest";
import { Capabilities } from "@wsp/protocol";
import { BoxBackend } from "../src/box-backend.js";
import { FakeBackend } from "../src/fake-backend.js";
import { LocalBackend } from "../src/local-backend.js";
import { NoProviderBackend } from "../src/no-provider-backend.js";
import { SolariBackend } from "../src/solari-backend.js";
import { SshBackend } from "../src/ssh-backend.js";

/** Every backend a host can wire, with what each says about copies. A computer the person owns copies a folder of
 * theirs and shares its ports; a fork of an image is its own machine with its own network; a machine wsp only
 * reaches copies nothing, and neither does a host with no provider at all. */
const ROWS: readonly { name: string; capabilities: Capabilities; copies: boolean; ownNetwork: boolean }[] = [
  { name: "this computer", capabilities: new LocalBackend({ root: "/tmp/wsp-flags" }).capabilities, copies: true, ownNetwork: false },
  { name: "box", capabilities: new BoxBackend({ apiKey: "sk-ant-x" }).capabilities, copies: true, ownNetwork: true },
  { name: "solari", capabilities: new SolariBackend({ apiKey: "sk-ant-x" }).capabilities, copies: true, ownNetwork: true },
  { name: "ssh", capabilities: new SshBackend({}).capabilities, copies: false, ownNetwork: false },
  { name: "no provider", capabilities: new NoProviderBackend().capabilities, copies: false, ownNetwork: false },
  { name: "the stand-in", capabilities: new FakeBackend().capabilities, copies: true, ownNetwork: true },
];

describe("every backend answers both flags", () => {
  for (const row of ROWS) {
    it(`${row.name} says copies ${row.copies} and its own network ${row.ownNetwork}`, () => {
      expect(Capabilities.parse(row.capabilities).copies).toBe(row.copies);
      expect(Capabilities.parse(row.capabilities).ownNetwork).toBe(row.ownNetwork);
    });
  }

  it("is the whole list: a backend module with no row here is a computer nothing asked about copies", () => {
    expect(ROWS.map(r => r.name).sort()).toEqual(["box", "no provider", "solari", "ssh", "the stand-in", "this computer"]);
  });
});
