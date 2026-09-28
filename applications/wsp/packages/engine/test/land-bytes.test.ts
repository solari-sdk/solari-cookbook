// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { landBytes, landsBytes } from "../src/land-bytes.js";
import type { Machine } from "../src/machine.js";

const bare = (extra: Partial<Machine>): Machine => ({
  id: "m1",
  kind: "sandbox",
  exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  snapshot: async () => "s1",
  pause: async () => {},
  resume: async () => {},
  kill: async () => {},
  state: async () => "running",
  downloadUrl: async () => { throw new Error("no signed download URL"); },
  uploadUrl: async () => { throw new Error("no signed upload URL"); },
  ...extra,
});

describe("landBytes", () => {
  it("takes the backend's own road when it has one, with the caller's own bound on it", async () => {
    const landed: { path: string; text: string; timeoutMs?: number }[] = [];
    const machine = bare({ putBytes: async (path, bytes, opts) => void landed.push({ path, text: Buffer.from(bytes).toString("utf8"), ...opts }) });
    await landBytes(machine, "/root/x.tgz", Buffer.from("payload"));
    await landBytes(machine, "/root/y.tgz", Buffer.from("more"), { timeoutMs: 5_000 });
    expect(landed).toEqual([
      { path: "/root/x.tgz", text: "payload" },
      { path: "/root/y.tgz", text: "more", timeoutMs: 5_000 },
    ]);
  });

  it("puts the bytes at the signed URL when that is the only road", async () => {
    const puts: { url: string; method: string | undefined }[] = [];
    const machine = bare({ uploadUrl: async path => `https://put.example${path}` });
    await landBytes(machine, "/root/x.tgz", Buffer.from("payload"), {
      fetch: (async (url: string, init: { method?: string }) => {
        puts.push({ url: String(url), method: init.method });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof globalThis.fetch,
    });
    expect(puts).toEqual([{ url: "https://put.example/root/x.tgz", method: "PUT" }]);
  });

  it("names the file and the machine when the signed PUT is refused", async () => {
    const machine = bare({ uploadUrl: async () => "https://put.example/x" });
    await expect(landBytes(machine, "/root/x.tgz", Buffer.from("p"), {
      fetch: (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof globalThis.fetch,
    })).rejects.toThrow("/root/x.tgz did not land on m1: HTTP 503");
  });

  it("says whether bytes can land at all, so nothing offers a daemon where they could not", () => {
    expect(landsBytes({ signedUrls: true }, bare({}))).toBe(true);
    expect(landsBytes({ signedUrls: false }, bare({}))).toBe(false);
    expect(landsBytes({ signedUrls: false }, bare({ putBytes: async () => {} }))).toBe(true);
  });
});
