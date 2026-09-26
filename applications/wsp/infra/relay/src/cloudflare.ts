// SPDX-License-Identifier: AGPL-3.0-only
// The Cloudflare account API, at its boundary: every call the relay makes to
// somebody else's service goes through `api`, which is the one thing a test
// stands in for. A tunnel is made with its config held on Cloudflare's side,
// since that is what a connector started with a token alone reads.
import type { Env, Zone } from "./env.js";
import type { Deps } from "./index.js";
import { Refusal, refuse } from "./refusal.js";

const API = "https://api.cloudflare.com/client/v4";

/** Cloudflare's code for a record that is already there under that name. */
const ALREADY_EXISTS = 81053;

interface Envelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result: T;
}

async function api<T>(env: Env, deps: Deps, method: string, path: string, body?: unknown): Promise<T> {
  const request = new Request(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await deps.fetch(request);
  const answer = (await res.json().catch(() => undefined)) as Envelope<T> | undefined;
  if (!res.ok || answer?.success !== true) {
    const errors = answer?.errors ?? [];
    const why = errors.length > 0 ? errors.map(e => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join(", ") : `HTTP ${res.status}`;
    // The codes travel as themselves, not inside the sentence: a refusal whose words happen to quote a code is
    // still whatever its own code says it is.
    throw refuse(502, `the Cloudflare account API refused ${method} ${path}: ${why}`, errors.flatMap(e => (typeof e.code === "number" ? [e.code] : [])));
  }
  return answer.result;
}

/** A tunnel of this account's, named after the host it carries. */
export async function createTunnel(env: Env, deps: Deps, name: string): Promise<string> {
  const made = await api<{ id: string }>(env, deps, "POST", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`, { name, config_src: "cloudflare" });
  return made.id;
}

/** What a connector is started with. It is the tunnel's whole credential, so it is answered to the host that owns it and logged nowhere. */
export async function tunnelToken(env: Env, deps: Deps, tunnelId: string): Promise<string> {
  return api<string>(env, deps, "GET", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);
}

/** Where the tunnel puts what arrives: this host's own loopback port, and nothing else answered at all. */
export async function setIngress(env: Env, deps: Deps, tunnelId: string, hostname: string, port: number): Promise<void> {
  await api(env, deps, "PUT", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
    config: { ingress: [{ hostname, service: `http://127.0.0.1:${port}` }, { service: "http_status:404" }] },
  });
}

/** A tunnel with connections still registered cannot be deleted, and a connector that just went leaves them behind
 * for a few minutes, so the connections go first. (Measured against the account API on 2026-09-11.) */
export async function deleteTunnel(env: Env, deps: Deps, tunnelId: string): Promise<void> {
  await api(env, deps, "DELETE", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/connections`);
  await api(env, deps, "DELETE", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`);
}

/** What a CNAME under the zone must say for this tunnel. */
const tunnelTarget = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;

/** The name is only ever one this relay derived from a host id, so a record already standing under it is this
 * relay's own from a run that did not finish: it is adopted when it already points at this tunnel and pointed at
 * this one when it does not. Without this a single 81053 leaves a box with no tunnel token for good. */
export async function createCname(env: Env, deps: Deps, zone: Zone, hostname: string, tunnelId: string): Promise<void> {
  const record = { type: "CNAME", name: hostname, content: tunnelTarget(tunnelId), proxied: true, comment: "wsp relay" };
  try {
    await api(env, deps, "POST", `/zones/${zone.zoneId}/dns_records`, record);
    return;
  } catch (e) {
    if (!(e instanceof Refusal) || !e.codes.includes(ALREADY_EXISTS)) throw e;
  }
  const standing = await api<{ id: string; content: string }[]>(env, deps, "GET", `/zones/${zone.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
  const held = standing[0];
  if (held === undefined) throw refuse(502, `${hostname} is taken on ${zone.zone} and the zone will not say by what`);
  if (held.content === tunnelTarget(tunnelId)) return;
  await api(env, deps, "PUT", `/zones/${zone.zoneId}/dns_records/${held.id}`, record);
}

export async function deleteCname(env: Env, deps: Deps, zone: Zone, hostname: string): Promise<void> {
  const found = await api<{ id: string }[]>(env, deps, "GET", `/zones/${zone.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
  for (const record of found) await api(env, deps, "DELETE", `/zones/${zone.zoneId}/dns_records/${record.id}`);
}
