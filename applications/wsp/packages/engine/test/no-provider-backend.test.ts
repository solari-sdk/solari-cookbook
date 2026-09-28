// SPDX-License-Identifier: AGPL-3.0-only
// The provider module a host with no provider key wires: it holds no machine
// and every road through it says so in one sentence.
import { NO_PROVIDER_LINE } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { NoProviderBackend } from "../src/no-provider-backend.js";

describe("no provider backend", () => {
  it("every capability is false and it offers no sizes, so every road that reads one refuses before it reaches here", () => {
    expect(new NoProviderBackend().capabilities).toEqual({
      liveCloneForks: false,
      replacesMachine: false,
      previewUrls: false,
      signedUrls: false,
      callbackRelay: false,
      diskSnapshots: false,
      images: false,
      snapshotsAnyLife: false,
      snapshotListing: false,
      templates: false,
      sizes: [],
      // Nothing here is a machine of the person's; there is no machine at all.
      kept: false,
      // Nothing forks and nothing copies: there is nothing to copy onto.
      copies: false,
      ownNetwork: false,
    });
  });

  it("it holds nothing, so the listing is empty rather than a refusal: a host reading its fleet finds none", async () => {
    expect(await new NoProviderBackend().list()).toEqual([]);
  });

  it("every road that would touch a machine says how to get one, in place of a provider's own refusal", async () => {
    const backend = new NoProviderBackend();
    await expect(backend.create()).rejects.toThrow(NO_PROVIDER_LINE);
    await expect(backend.get()).rejects.toThrow(NO_PROVIDER_LINE);
    await expect(backend.deleteSnapshot()).rejects.toThrow(NO_PROVIDER_LINE);
    // The road out is the verb off the front page, never a shell variable: this is the first refusal a person who
    // typed wsp new on a fresh home reads, and one provider's variable is not the answer for the others.
    expect(NO_PROVIDER_LINE).toContain("wsp add <provider>");
    expect(NO_PROVIDER_LINE).not.toContain("SOLARI_API_KEY");
    expect(NO_PROVIDER_LINE).toContain("wsp init");
  });

  it("nothing bills on it and it names no size to bill for", () => {
    const { pricing } = new NoProviderBackend();
    expect(pricing.rateUsdPerHour({ cpu: 4, memMb: 8192 })).toBe(0);
    expect(pricing.defaultSize).toEqual({ cpu: 0, memMb: 0 });
  });
});
