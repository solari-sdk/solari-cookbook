// SPDX-License-Identifier: AGPL-3.0-only
// The relay: a directory and an introducer, never in the middle of the
// conversation. It knows which boxes a person owns, where each answers and
// which key each proves, which computers signed in and which of them a
// computer already in admitted, and that is all it can know: no pairing code,
// no device token, no private key and no byte of a thread passes through
// here, and an admission is bytes it carries and cannot make. Adding a route
// is one row in the table below and one function beside the ones it sits with.
import { clientAdmit, clientDelete, clientList, clientSignOut } from "./clients.js";
import type { Env } from "./env.js";
import { hostAdd, hostDelete, hostHeartbeat, hostList, hostTunnel } from "./hosts.js";
import { carriesBearer, linkApprove, linkCallback, linkPoll, linkStart, linkTyped, linkVerify } from "./link.js";
import { refusalPage } from "./page.js";
import { Refusal } from "./refusal.js";

/** Everything the Worker reaches outside itself: one road out, one clock, one source of secrets. Tests hand in their own. */
export interface Deps {
  fetch(request: Request): Promise<Response>;
  now(): number;
  random(bytes: number): Uint8Array;
}

export const systemDeps: Deps = {
  fetch: request => fetch(request),
  now: () => Date.now(),
  random: bytes => crypto.getRandomValues(new Uint8Array(bytes)),
};

export interface Ctx {
  req: Request;
  env: Env;
  deps: Deps;
  url: URL;
  params: Record<string, string>;
}

interface Route {
  method: string;
  /** Path with `:name` where a value stands. */
  path: string;
  handle(ctx: Ctx): Promise<Response>;
  /** A browser opens this route, so a refusal on it renders as a page; a program's request here still reads JSON. */
  page?: true;
}

const ROUTES: readonly Route[] = [
  { method: "POST", path: "/link/start", handle: linkStart },
  { method: "GET", path: "/link/verify", handle: linkVerify, page: true },
  { method: "POST", path: "/link/verify", handle: linkTyped, page: true },
  { method: "GET", path: "/link/callback", handle: linkCallback, page: true },
  { method: "POST", path: "/link/approve", handle: linkApprove, page: true },
  { method: "POST", path: "/link/poll", handle: linkPoll },
  { method: "GET", path: "/hosts", handle: hostList },
  { method: "POST", path: "/hosts", handle: hostAdd },
  { method: "GET", path: "/clients", handle: clientList },
  { method: "DELETE", path: "/clients/:id", handle: clientDelete },
  { method: "POST", path: "/clients/:id/signout", handle: clientSignOut, page: true },
  { method: "POST", path: "/clients/:id/admissions", handle: clientAdmit },
  { method: "POST", path: "/hosts/:id/tunnel", handle: hostTunnel },
  { method: "POST", path: "/hosts/:id/heartbeat", handle: hostHeartbeat },
  { method: "DELETE", path: "/hosts/:id", handle: hostDelete },
];

/** The values a route's path took, or nothing when this is not that route. */
function match(path: string, against: string): Record<string, string> | undefined {
  const want = against.split("/");
  const got = path.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (const [at, part] of want.entries()) {
    const here = got[at]!;
    if (part.startsWith(":")) {
      if (here === "") return undefined;
      params[part.slice(1)] = decodeURIComponent(here);
    } else if (part !== here) return undefined;
  }
  return params;
}

export async function handle(req: Request, env: Env, deps: Deps = systemDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  // The matching is inside the try with the handlers: a path holding a broken percent escape is a refusal a caller
  // reads, not an exception out of fetch.
  let taken: Route | undefined;
  try {
    for (const route of ROUTES) {
      const params = match(path, route.path);
      if (params === undefined || route.method !== req.method) continue;
      taken = route;
      return await route.handle({ req, env, deps, url, params });
    }
    // A path more than one method answers on is matched by each of them, so the method is what is wrong here only
    // when no route on this path took it.
    if (ROUTES.some(route => match(path, route.path) !== undefined)) return Response.json({ error: `${req.method} is not what ${path} answers` }, { status: 405 });
  } catch (e) {
    if (e instanceof Refusal) return taken?.page === true && !carriesBearer(req) ? refusalPage(e.status, e.message) : Response.json({ error: e.message }, { status: e.status });
    if (e instanceof URIError) return Response.json({ error: `that path is not one this relay can read: ${path}` }, { status: 400 });
    // The words of an unexpected failure stay in this Worker's own log: a person on the other end gets the fact and no more.
    console.error(e);
    return Response.json({ error: "this relay failed on that request" }, { status: 500 });
  }
  return Response.json({ error: `no route: ${req.method} ${path}` }, { status: 404 });
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env),
};
