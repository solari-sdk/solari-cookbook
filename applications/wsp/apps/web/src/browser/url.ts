// SPDX-License-Identifier: AGPL-3.0-only
// Address arithmetic for the browser pane. A tab is a guest port and a path;
// the route the runtime mints is per port and carries the edge's pt_token in
// its query, so the frame's src is that route with the path put before the
// query, and the bar shows the loopback form, never the token.

/** A guest port and the path, with its query, framed on it; "/" is the root. */
export interface Address {
  readonly port: number;
  readonly path: string;
}

const ROOT = "/";
const TOKEN_PARAM = "pt_token";

const afterPort = (path: string): string => (path === ROOT ? "" : path);

/** "http://localhost:3000" or "http://localhost:3000/about?x=1"; recents key off this and browsers dial it, so it stays encoded. */
export const loopbackUrl = (port: number, path: string = ROOT): string => `http://localhost:${port}${afterPort(path)}`;

/** "localhost:3000" or "localhost:3000/about?x=1": what the bar shows. */
export const loopbackAddress = (port: number, path: string): string => `localhost${portAndPath(port, path)}`;

/** ":3000" or ":3000/about?x=1": how a tab names where it is, decoded for reading. */
export const portAndPath = (port: number, path: string): string => `:${port}${afterPort(readablePath(path))}`;

/** decodeURI keeps the escapes that would change the path's shape and throws on a malformed one, shown as typed then. */
function readablePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * The guest port and path a typed address means: "3000", ":3000", "3000/about",
 * "localhost:3000/about?x=1" or a loopback URL. Anything on another host is
 * not something this pane can frame, so it parses to null.
 */
export function parseAddress(raw: string): Address | null {
  const text = raw.trim();
  const bare = /^:?(\d{1,5})([/?#].*)?$/.exec(text);
  const withScheme = bare ? `http://localhost:${bare[1]}${bare[2] ?? ""}` : /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, path: `${parsed.pathname}${parsed.search}${parsed.hash}` };
}

/** The minted route for the port with the path before its query and the edge's token kept beside the page's own
 * parameters; a pt_token typed into the page's query is dropped so the edge only ever sees the minted one. */
export function frameSrc(route: string, path: string): string {
  const src = new URL(route);
  const hashAt = path.indexOf("#");
  const beforeHash = hashAt === -1 ? path : path.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const pageQuery = queryAt === -1 ? [] : beforeHash.slice(queryAt + 1).split("&");
  src.pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  src.search = [src.search.slice(1), ...pageQuery.filter(pair => pair !== "" && pair.split("=")[0] !== TOKEN_PARAM)].join("&");
  src.hash = hashAt === -1 ? "" : path.slice(hashAt);
  return src.toString();
}
