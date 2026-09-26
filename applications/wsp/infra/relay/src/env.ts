// SPDX-License-Identifier: AGPL-3.0-only
// What a deployment of the relay is given: one D1, the account it makes
// tunnels on, the GitHub app the verify page signs people in with, and the key
// its own tokens are signed by. The zone is the one setting that decides
// whether hosts get a name of their own: without it the relay makes no tunnel
// at all and every host runs a quick tunnel and says where it landed.
import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  RELAY_ZONE: string;
  RELAY_ZONE_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  RELAY_SIGNING_KEY: string;
}

export interface Zone {
  zone: string;
  zoneId: string;
}

/** The zone managed hostnames are made under, or nothing when this deployment has none. */
export function zoneOf(env: Env): Zone | undefined {
  const zone = (env.RELAY_ZONE ?? "").trim();
  const zoneId = (env.RELAY_ZONE_ID ?? "").trim();
  return zone === "" || zoneId === "" ? undefined : { zone, zoneId };
}

/** The one name this relay may write or delete under its zone for a host: the host's own id and nothing else.
 * Every road to the DNS API reads it here, so no string a box sent can ever become a name the relay acts on. */
export function managedHostname(hostId: string, zone: Zone): string {
  return `${hostId}.${zone.zone}`;
}

/** The only hostname a box may report for itself: the quick tunnel it was told to run when this relay had no zone.
 * A managed name is the relay's own to write, and a heartbeat is a display line, never a DNS instruction.
 * The same shape is spelled a second time in the host's own connector (quickHostname in packages/host/src/connector.ts),
 * which reads it off the connector's output; a Worker and a command line share no module, so a change to one of
 * these is a change to both. */
export function isQuickTunnel(hostname: string): boolean {
  return /^[a-z0-9-]+\.trycloudflare\.com$/i.test(hostname);
}

/** What a host reads when it asked for a tunnel and this relay has no name to give it. */
export const NO_ZONE_LINE = "this relay has no zone configured, so it hands out no hostname; run a quick tunnel and send the hostname it prints with the heartbeat";
