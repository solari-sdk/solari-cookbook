// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from "vitest";

/** The gateway as it answered on 2026-09-26: two copies behind one address, one holding every running sandbox and
 * one that never heard of them, each call after a create landing on whichever copy `route` names. The empty copy
 * answers a delete with the same 200 and every read with a 404; only a delete that lands on the holder ends it. */
export function splitGateway(route: (call: number, method: string) => "holder" | "empty") {
  const holder = new Map<string, string>();
  let call = 0;
  let made = 0;
  const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const id = `sb${++made}`;
      holder.set(id, "running");
      return new Response(JSON.stringify({ sandboxId: id, kind: "sandbox" }), { status: 201 });
    }
    const id = decodeURIComponent(new URL(String(url)).pathname.split("/")[2] ?? "");
    const known = route(call++, method) === "holder" && holder.has(id);
    if (method === "DELETE") {
      if (known) holder.delete(id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return known
      ? new Response(JSON.stringify({ sandboxId: id, kind: "sandbox", state: holder.get(id) }), { status: 200 })
      : new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
  return { f, holder, deletes: () => f.mock.calls.filter(c => c[1]?.method === "DELETE").length };
}
