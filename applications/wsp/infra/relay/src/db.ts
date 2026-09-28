// SPDX-License-Identifier: AGPL-3.0-only
// Every statement the relay runs, in one place, so what it keeps can be read
// off one file and held to the migration beside it.
import type { Env } from "./env.js";

export interface AccountRow {
  id: string;
  provider: string;
  provider_id: string;
  login: string;
  created_at: string;
}

export interface HostRow {
  id: string;
  account_id: string;
  name: string;
  hostname: string | null;
  tunnel_id: string | null;
  connector_version: string | null;
  created_at: string;
  last_seen: string | null;
  /** The fingerprint of the key the box proves at every dial, written once off its first beat that names it or at
   * the add from a signed-in computer; a computer pins it off the listing before its first dial. */
  host_key: string | null;
}

export type LinkState = "pending" | "approved";

export interface LinkRow {
  code: string;
  poll_hash: string;
  kind: "host" | "client";
  name: string;
  state: LinkState;
  account_id: string | null;
  host_id: string | null;
  created_at: string;
  expires_at: string;
  /** The address the start came from, empty where the connector named none; what the caps on the start are counted under. */
  source: string;
  /** The fingerprint of the device key a computer signed in with; a box's link carries none. */
  fingerprint: string | null;
  /** The admission a signed-in wsp's approval carried, as JSON, moved onto the admissions table by the poll that
   * mints the client; an approval on the page leaves none. */
  admission: string | null;
}

export async function accountOf(env: Env, id: string): Promise<AccountRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>()) ?? undefined;
}

export async function accountByProvider(env: Env, provider: string, providerId: string): Promise<AccountRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM accounts WHERE provider = ? AND provider_id = ?").bind(provider, providerId).first<AccountRow>()) ?? undefined;
}

export async function insertAccount(env: Env, row: AccountRow): Promise<void> {
  await env.DB.prepare("INSERT INTO accounts (id, provider, provider_id, login, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.provider, row.provider_id, row.login, row.created_at)
    .run();
}

/** The login a person signs in under can change on their side; the account is the same one either way. */
export async function renameAccount(env: Env, id: string, login: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET login = ? WHERE id = ?").bind(login, id).run();
}

export async function hostOf(env: Env, id: string): Promise<HostRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(id).first<HostRow>()) ?? undefined;
}

export async function hostsOf(env: Env, accountId: string): Promise<HostRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM hosts WHERE account_id = ? ORDER BY name").bind(accountId).all<HostRow>();
  return results;
}

/** Whether this account already holds a box under this name, which is what tells one of a person's boxes from another. */
export async function hostNamed(env: Env, accountId: string, name: string): Promise<HostRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM hosts WHERE account_id = ? AND name = ?").bind(accountId, name).first<HostRow>()) ?? undefined;
}

export async function insertHost(env: Env, row: Pick<HostRow, "id" | "account_id" | "name" | "created_at"> & Partial<Pick<HostRow, "host_key">>): Promise<void> {
  await env.DB.prepare("INSERT INTO hosts (id, account_id, name, created_at, host_key) VALUES (?, ?, ?, ?, ?)").bind(row.id, row.account_id, row.name, row.created_at, row.host_key ?? null).run();
}

/** The key a box proves is written once: the update takes a row holding none or holding this same key, so two beats
 * racing to name it land one key between them, and a beat naming another changes nothing and reads as refused. */
export async function setHostKey(env: Env, id: string, hostKey: string): Promise<boolean> {
  const { meta } = await env.DB.prepare("UPDATE hosts SET host_key = ? WHERE id = ? AND (host_key IS NULL OR host_key = ?)").bind(hostKey, id, hostKey).run();
  return (meta.changes ?? 0) > 0;
}

/** Written the moment the tunnel exists, before anything else can fail: a tunnel no row points at is one nothing
 * can ever delete through this relay. */
export async function setHostTunnel(env: Env, id: string, tunnelId: string): Promise<void> {
  await env.DB.prepare("UPDATE hosts SET tunnel_id = ? WHERE id = ?").bind(tunnelId, id).run();
}

export async function setHostHostname(env: Env, id: string, hostname: string): Promise<void> {
  await env.DB.prepare("UPDATE hosts SET hostname = ? WHERE id = ?").bind(hostname, id).run();
}

export async function seenHost(env: Env, id: string, at: string, seen: { hostname?: string; version?: string }): Promise<void> {
  await env.DB.prepare("UPDATE hosts SET last_seen = ?, hostname = COALESCE(?, hostname), connector_version = COALESCE(?, connector_version) WHERE id = ?")
    .bind(at, seen.hostname ?? null, seen.version ?? null, id)
    .run();
}

export async function deleteHost(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM hosts WHERE id = ?").bind(id).run();
}

export interface ClientRow {
  id: string;
  account_id: string;
  name: string;
  created_at: string;
  last_seen: string | null;
  /** The fingerprint of the device key this computer signed in with, one computer's per account under the index
   * beside the column; a computer signed in before device keys holds none, and no box can admit it. */
  fingerprint: string | null;
}

export async function clientOf(env: Env, id: string): Promise<ClientRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first<ClientRow>()) ?? undefined;
}

export async function clientsOf(env: Env, accountId: string): Promise<ClientRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM clients WHERE account_id = ? ORDER BY created_at").bind(accountId).all<ClientRow>();
  return results;
}

/** The computer this account holds under this key whose sign-in still stands, if any: a key is one computer's on
 * an account, as a name is one box's; a code that named no key is held by nobody, and a row signed in before the
 * moment named holds a token that opens nothing, so it holds the key for nobody either. */
export async function clientKeyed(env: Env, accountId: string, fingerprint: string | null, since: string): Promise<ClientRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM clients WHERE account_id = ? AND fingerprint = ? AND created_at >= ?").bind(accountId, fingerprint, since).first<ClientRow>()) ?? undefined;
}

/** The row a run-out sign-in left under this key goes, admissions with it, so the index meets nothing when the
 * same computer signs in again: the one road that frees a key without a token, since the token that could have
 * signed the row out is the one that ran out. */
export async function deleteRunOutClient(env: Env, accountId: string, fingerprint: string | null, before: string): Promise<void> {
  await env.DB.prepare("DELETE FROM admissions WHERE client_id IN (SELECT id FROM clients WHERE account_id = ? AND fingerprint = ? AND created_at < ?)").bind(accountId, fingerprint, before).run();
  await env.DB.prepare("DELETE FROM clients WHERE account_id = ? AND fingerprint = ? AND created_at < ?").bind(accountId, fingerprint, before).run();
}

/** Answers whether the row landed: the index keeps one computer per key on an account, so a poll that lost to
 * another code approved under the same key reads a refusal off this answer rather than a failed statement. */
export async function insertClient(env: Env, row: Pick<ClientRow, "id" | "account_id" | "name" | "created_at" | "fingerprint">): Promise<boolean> {
  const { meta } = await env.DB.prepare("INSERT INTO clients (id, account_id, name, created_at, fingerprint) VALUES (?, ?, ?, ?, ?) ON CONFLICT (account_id, fingerprint) DO NOTHING")
    .bind(row.id, row.account_id, row.name, row.created_at, row.fingerprint)
    .run();
  return (meta.changes ?? 0) > 0;
}

export async function seenClient(env: Env, id: string, at: string): Promise<void> {
  await env.DB.prepare("UPDATE clients SET last_seen = ? WHERE id = ?").bind(at, id).run();
}

/** A computer's admissions go with it: a box reading the next beat sees neither, and revokes what it admitted. */
export async function deleteClient(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM admissions WHERE client_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id).run();
}

/** Bytes a computer already in signed to let another onto the account's boxes. The relay stores and forwards them:
 * it verifies no signature and holds no key that could make one, so a row here admits nobody on its own. */
export interface AdmissionRow {
  id: string;
  account_id: string;
  client_id: string;
  /** The fingerprint of the key that signed it, which the box resolves to a public key it already holds. */
  signer: string;
  issued_at: string;
  signature: string;
  created_at: string;
}

/** One admission per signer per computer, the latest bytes standing: what one client token can grow here is bounded
 * by the account's own computers, not by how often it posts. */
export async function insertAdmission(env: Env, row: AdmissionRow): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO admissions (id, account_id, client_id, signer, issued_at, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT (client_id, signer) DO UPDATE SET issued_at = excluded.issued_at, signature = excluded.signature, created_at = excluded.created_at",
  )
    .bind(row.id, row.account_id, row.client_id, row.signer, row.issued_at, row.signature, row.created_at)
    .run();
}

/** Every admission on the account, grouped under the computer it admits, oldest first. */
export async function admissionsByClient(env: Env, accountId: string): Promise<Map<string, AdmissionRow[]>> {
  const { results } = await env.DB.prepare("SELECT * FROM admissions WHERE account_id = ? ORDER BY created_at").bind(accountId).all<AdmissionRow>();
  const grouped = new Map<string, AdmissionRow[]>();
  for (const row of results) grouped.set(row.client_id, [...(grouped.get(row.client_id) ?? []), row]);
  return grouped;
}

/** The one write that makes a link code, and the one reading of what its source already holds: both caps are
 * counted inside the statement that inserts, so a burst of starts from one address makes as many rows as the caps
 * allow and no more, the shape approveLink and spendLink below hold a race to. Answers whether this row landed. */
export async function insertLink(env: Env, row: LinkRow, caps: { pending: number; recent: number; since: string }): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    "INSERT INTO link_codes (code, poll_hash, kind, name, state, account_id, host_id, created_at, expires_at, source, fingerprint)" +
      " SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?" +
      " WHERE (SELECT COUNT(*) FROM link_codes WHERE source = ? AND state = 'pending') < ?" +
      " AND (SELECT COUNT(*) FROM link_codes WHERE source = ? AND created_at > ?) < ?",
  )
    .bind(row.code, row.poll_hash, row.kind, row.name, row.state, row.account_id, row.host_id, row.created_at, row.expires_at, row.source, row.fingerprint, row.source, caps.pending, row.source, caps.since, caps.recent)
    .run();
  return (meta.changes ?? 0) > 0;
}

/** What one source already holds here: its codes still waiting to be approved, and how many it started since the
 * moment named. Read after a refused insert, to say which of the two caps refused it. */
export async function linksFrom(env: Env, source: string, since: string): Promise<{ pending: number; recent: number }> {
  const counts = await env.DB.prepare(
    "SELECT SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS recent FROM link_codes WHERE source = ?",
  )
    .bind(since, source)
    .first<{ pending: number | null; recent: number | null }>();
  return { pending: counts?.pending ?? 0, recent: counts?.recent ?? 0 };
}

export async function linkByCode(env: Env, code: string): Promise<LinkRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first<LinkRow>()) ?? undefined;
}

export async function linkByPoll(env: Env, pollHash: string): Promise<LinkRow | undefined> {
  return (await env.DB.prepare("SELECT * FROM link_codes WHERE poll_hash = ?").bind(pollHash).first<LinkRow>()) ?? undefined;
}

/** Approval is the one write that turns a pending code into a token waiting to be collected, and it happens once:
 * the update names the state it expects, so two browsers racing on one code make one host between them. The
 * admission rides the row to the poll, which is where the client it is for gets an id. */
export async function approveLink(env: Env, code: string, accountId: string, hostId: string | null, admission: string | null = null): Promise<boolean> {
  const { meta } = await env.DB.prepare("UPDATE link_codes SET state = 'approved', account_id = ?, host_id = ?, admission = ? WHERE code = ? AND state = 'pending'")
    .bind(accountId, hostId, admission, code)
    .run();
  return (meta.changes ?? 0) > 0;
}

/** Takes the row and says whether this caller is the one that took it: two polls racing on one approved code both
 * read the row, and only the one whose delete changed something may mint. */
export async function spendLink(env: Env, code: string): Promise<boolean> {
  const { meta } = await env.DB.prepare("DELETE FROM link_codes WHERE code = ?").bind(code).run();
  return (meta.changes ?? 0) > 0;
}

export async function deleteLink(env: Env, code: string): Promise<void> {
  await env.DB.prepare("DELETE FROM link_codes WHERE code = ?").bind(code).run();
}

/** Every code that ran out, and the host an approval made for a code nobody ever collected: a token was never
 * handed out for it, so the row it left is nobody's. Run at every start, which is the only clock a Worker has for
 * free. Answers how many codes went, which the test reads. */
export async function sweepLinks(env: Env, now: number): Promise<number> {
  const at = new Date(now).toISOString();
  await env.DB.prepare("DELETE FROM hosts WHERE id IN (SELECT host_id FROM link_codes WHERE host_id IS NOT NULL AND expires_at <= ?)").bind(at).run();
  const { meta } = await env.DB.prepare("DELETE FROM link_codes WHERE expires_at <= ?").bind(at).run();
  return meta.changes ?? 0;
}
