// SPDX-License-Identifier: AGPL-3.0-only
// The one authenticated read that says whether the provider takes a key, and
// how its three answers read: taken, refused in the provider's own words, or
// never answered.
import { describe, expect, it, vi } from "vitest";
import { checkProviderKey, keyCheckLine } from "../src/key-check.js";
import { LocalBackend } from "../src/local-backend.js";
import { SolariBackend } from "../src/solari-backend.js";
import type { MachineBackend } from "../src/machine.js";

function fetchOf(reply: { status: number; body: unknown } | Error) {
  return vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
}

const local = (): MachineBackend => new LocalBackend({ root: "/tmp" });

describe("the provider key check", () => {
  it("asks the template table, the cheapest read the key opens, and nothing else", async () => {
    const f = fetchOf({ status: 200, body: { templates: [{ templateId: "base", name: "base", status: "ready" }] } });
    const check = await checkProviderKey(new SolariBackend({ apiKey: "slr_live_fake", fetch: f as unknown as typeof fetch }));
    expect(check).toEqual({ state: "taken" });
    expect(keyCheckLine(check, "solari")).toBeUndefined();
    expect(f.mock.calls).toHaveLength(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://api.getsolari.com/templates");
  });

  it("reads a refusal as the provider's own status and word, under our sentence for the step that asked", async () => {
    const b = new SolariBackend({ apiKey: "slr_live_wrong", fetch: fetchOf({ status: 401, body: { error: "Unauthorized" } }) as unknown as typeof fetch });
    const check = await checkProviderKey(b);
    expect(check).toEqual({ state: "refused", said: "401 Unauthorized" });
    expect(keyCheckLine(check, "solari")).toBe("Solari refused this key: 401 Unauthorized");
    expect(keyCheckLine(check, "box")).toBe("Box by ASCII refused this key: 401 Unauthorized");
    expect(keyCheckLine(check, "solari", true)).toBe("Solari refused the saved key: 401 Unauthorized");
    expect(keyCheckLine(check, "box", true)).toBe("Box by ASCII refused the saved key: 401 Unauthorized");
  });

  it("a plan that may not read the account is the same refusal: the key alone will not do", async () => {
    const b = new SolariBackend({ apiKey: "slr_live_free", fetch: fetchOf({ status: 403, body: { error: "NotEntitled" } }) as unknown as typeof fetch });
    expect(await checkProviderKey(b)).toEqual({ state: "refused", said: "403 NotEntitled" });
  });

  it("a road that never left this computer says so instead of blaming the key", async () => {
    const b = new SolariBackend({ apiKey: "slr_live_fake", fetch: fetchOf(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })) as unknown as typeof fetch, clock: { now: Date.now, sleep: async () => {} } });
    const check = await checkProviderKey(b);
    expect(check).toEqual({ state: "unchecked", said: "fetch failed" });
    expect(keyCheckLine(check, "solari")).toBe("Solari could not be reached to check the key: fetch failed");
    expect(keyCheckLine(check, "box")).toBe("Box by ASCII could not be reached to check the key: fetch failed");
    // Nothing about the key came back, so the saved wording does not turn it into a refusal either.
    expect(keyCheckLine(check, "solari", true)).toBe("Solari could not be reached to check the key: fetch failed");
  });

  it("a gateway status answered about the gateway, not the key", async () => {
    const b = new SolariBackend({ apiKey: "slr_live_fake", fetch: fetchOf({ status: 503, body: { error: "Service Unavailable" } }) as unknown as typeof fetch, clock: { now: Date.now, sleep: async () => {} } });
    expect(await checkProviderKey(b)).toEqual({ state: "unchecked", said: "Service Unavailable" });
  });

  it("a backend that holds no key has none to check", async () => {
    expect(await checkProviderKey(local())).toEqual({ state: "taken" });
  });
});
