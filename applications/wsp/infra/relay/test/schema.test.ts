// SPDX-License-Identifier: AGPL-3.0-only
// The relay is a directory, not a way in: the only credential it can hand out
// is a token for its own routes. This file holds the schema to that, so a
// column for a device token, a pairing code, a host's token or a private key
// cannot be added quietly. An admission is bytes a device signed, which the
// relay stores and cannot make.
import { describe, expect, it } from "vitest";
import { OWN_TABLES, relayHarness, type RelayHarness } from "./relay.js";

async function columnsOf(r: RelayHarness, table: string): Promise<string[]> {
  const { results } = await r.db.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{ name: string }>();
  return results.map(row => row.name).sort();
}

describe("what the relay keeps", () => {
  it("has these tables and no others", async () => {
    const relay = await relayHarness();
    const { results } = await relay.db.prepare(OWN_TABLES).all<{ name: string }>();
    expect(results.map(r => r.name).sort()).toEqual(["accounts", "admissions", "clients", "hosts", "link_codes"]);
  });

  it("holds no device token, pairing code, host token or private key in any column", async () => {
    const relay = await relayHarness();
    expect(await columnsOf(relay, "accounts")).toEqual(["created_at", "id", "login", "provider", "provider_id"]);
    expect(await columnsOf(relay, "hosts")).toEqual(["account_id", "connector_version", "created_at", "host_key", "hostname", "id", "last_seen", "name", "tunnel_id"]);
    expect(await columnsOf(relay, "link_codes")).toEqual(["account_id", "admission", "code", "created_at", "expires_at", "fingerprint", "host_id", "kind", "name", "poll_hash", "source", "state"]);
    expect(await columnsOf(relay, "clients")).toEqual(["account_id", "created_at", "fingerprint", "id", "last_seen", "name"]);
    expect(await columnsOf(relay, "admissions")).toEqual(["account_id", "client_id", "created_at", "id", "issued_at", "signature", "signer"]);
    // The words a column holding any of those would carry in its name; host_key and fingerprint are the public
    // half's hash, which opens nothing.
    const { results } = await relay.db.prepare(OWN_TABLES).all<{ name: string }>();
    for (const table of results) {
      for (const column of await columnsOf(relay, table.name)) expect(column, `${table.name}.${column}`).not.toMatch(/token|secret|private|pair/);
    }
  });

  it("indexes the column the sweep of dead codes reads", async () => {
    const relay = await relayHarness();
    const { results } = await relay.db.prepare("SELECT name FROM pragma_index_list(?)").bind("link_codes").all<{ name: string }>();
    const columns = await Promise.all(
      results.map(async index => {
        const { results: on } = await relay.db.prepare("SELECT name FROM pragma_index_info(?)").bind(index.name).all<{ name: string }>();
        return on.map(row => row.name).join(",");
      }),
    );
    expect(columns).toContain("expires_at");
  });

  it("holds a key to one computer per account, and leaves the rows from before device keys distinct", async () => {
    const relay = await relayHarness();
    const key = "SHA256:" + "k".repeat(43);
    const insert = (id: string, account: string, fingerprint: string | null): Promise<unknown> =>
      relay.db.prepare("INSERT INTO clients (id, account_id, name, created_at, fingerprint) VALUES (?, ?, ?, ?, ?)").bind(id, account, "a computer", "2026-09-11T12:00:00.000Z", fingerprint).run();
    await insert("c_1", "a_1", key);
    await expect(insert("c_2", "a_1", key)).rejects.toThrow(/UNIQUE/);
    // The same key on another account is another computer's sign-in there, and a row holding no key collides with nothing.
    await insert("c_3", "a_2", key);
    await insert("c_4", "a_1", null);
    await insert("c_5", "a_1", null);
    const { results } = await relay.db.prepare("SELECT id FROM clients ORDER BY id").all<{ id: string }>();
    expect(results.map(row => row.id)).toEqual(["c_1", "c_3", "c_4", "c_5"]);
  });

  it("refuses a bound undefined the way D1 does, rather than writing the null JSON would make of it", async () => {
    const relay = await relayHarness();
    await relay.db
      .prepare("INSERT INTO hosts (id, account_id, name, hostname, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("h_1", "a_1", "box", "blue-sky-1234.trycloudflare.com", "2026-09-11T12:00:00.000Z")
      .run();
    // The relay's own statement for the name a box reports, on a column that takes a null: an undefined slipping
    // into that bind is the one value JSON would carry through as a row nobody could write against the real D1.
    const written = relay.db.prepare("UPDATE hosts SET hostname = ? WHERE id = ?").bind(undefined, "h_1").run();
    await expect(written).rejects.toThrow("D1_TYPE_ERROR");
    const row = (await relay.db.prepare("SELECT hostname FROM hosts WHERE id = ?").bind("h_1").first()) as Record<string, string>;
    expect(row["hostname"]).toBe("blue-sky-1234.trycloudflare.com");
  });

  it("keeps the poll token as a hash, never as itself", async () => {
    const relay = await relayHarness();
    const { pollToken } = (await (await relay.fetch("/link/start", { method: "POST", body: JSON.stringify({ kind: "host", name: "box" }) })).json()) as { pollToken: string };
    const rows = await relay.db.prepare("SELECT * FROM link_codes").all();
    expect(JSON.stringify(rows.results)).not.toContain(pollToken);
  });
});
