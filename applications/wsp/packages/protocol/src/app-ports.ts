// SPDX-License-Identifier: AGPL-3.0-only
// The pair of ports the app is served on and the address it binds: the
// defaults, the offset the runtime's WebSocket port sits at above the app
// port, the one rule that reads a pair and an address off what a person named
// (which wsp up and wsp init both take theirs from), the one reading of what
// loopback is, and the words for a port somebody else holds. The rules and the
// words live together so the sentence that offers --port and --listen and the
// arithmetic behind them cannot drift apart.

/** The port the app is served on when nobody names one. */
export const DEFAULT_PORT = 4400;
/** How far above the app port the runtime's WebSocket port sits, so `--port` alone moves the pair. */
export const WS_PORT_OFFSET = 10;
/** The WebSocket port of the default pair. */
export const DEFAULT_WS_PORT = DEFAULT_PORT + WS_PORT_OFFSET;

/** How far above the app port the door for computers you own sits, so `--port` alone moves all three. */
export const PLACE_PORT_OFFSET = 20;
/** The port that door answers on for the default pair. */
export const DEFAULT_PLACE_PORT = DEFAULT_PORT + PLACE_PORT_OFFSET;

/** The first port base a copy of a project folder on this computer is handed, and the step between one copy's base
 * and the next. Above the ports a person's own dev server binds by habit (3000, 4400 is wsp's own) and below the
 * ephemeral range, so a base is neither the port somebody is already on nor one the kernel will hand out. The two
 * numbers live here because the app's own ports do, so nothing in the hidden range can land on a port wsp itself
 * holds. */
export const PORT_BASE_FIRST = 3100;
export const PORT_BASE_STEP = 100;

/** The address every host socket binds when nobody names another: the page carries the host token, so nothing
 * listens beyond this computer. */
export const LOOPBACK = "127.0.0.1";

/** The path on the app's own port that the runtime WebSocket answers upgrades on, so one address and one port carry
 * the page and the protocol, which is all an ssh forward or a tunnel hostname can carry. */
export const WS_PATH = "/ws";

/** The WebSocket address of a host at this address: the same authority over ws or wss, with the runtime's path on
 * the end of whatever path the address already carries, which is what a tunnel hostname under a prefix needs. It
 * sits beside WS_PATH because both the command line and a place's own agent turn an address into this one, and a
 * second copy of the rule would let one of them dial a path the runtime does not answer on. */
export function wsUrlOf(url: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss:" : "ws:";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${scheme}//${parsed.host}${path}${WS_PATH}`;
}

/** An address as a person reads and types it: the host and its port, which is the short form joinAddressOf takes
 * back. The door answers with a whole URL and no screen shows one, since a line carrying `http://` is longer than
 * the row it sits in and the scheme is the one part nobody has a choice about. */
export function joinAddressWord(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A peer's address as the person on the other screen would write it: an IPv4 address that arrived over a
 * dual-stack listener wears the ::ffff: prefix, which nobody typed. Read here and nowhere else, so the door that
 * shows a peer and the rule that reads one cannot disagree about what the peer is. */
export function peerAddress(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/, "");
}

/** Whether an address reaches no further than the computer it runs on. This decides whether the page is served
 * with the host token inlined and whether the JSON routes ask for a device token, so it is read once here and
 * nowhere else: two readings would let one road stay open while the other closed. A whole IPv4 literal in 127/8
 * and never a prefix, since this also reads the name a request asked for and `127.evil.example` is a name anyone
 * may register and point at this computer's own port. */
export function isLoopback(address: string): boolean {
  return address === "localhost" || address === "::1" || address === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/** The address that binds every address this computer answers on: what the door a computer you own dials is bound
 * to, and what reachAddresses is asked to spell out. */
export const WILDCARD = "0.0.0.0";

/** Whether an address is the wildcard, which binds every address this computer answers on, loopback included. A
 * tool on the computer itself dials such a host at loopback; a host on one named address answers only there. */
export function isWildcard(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

/** Whether a word is an address rather than a name: a host is reached at an http, https, ws or wss address, and a
 * word with any of those schemes is one, wherever it is typed (a --host flag, WSP_HOST, a login address). */
export function isUrl(word: string): boolean {
  return /^(https?|wss?):\/\//i.test(word);
}

/** The name of the computer in an address a host is served at, or nothing when the word is not one. isUrl takes
 * every address a socket is reached at, the ws and wss ones the runtime's own socket is dialed at included; this is
 * the narrower reading of an address a person is pointed at, and it hands back the name it found, so the check that
 * refuses a malformed address and the alias folded out of a good one are one parse rather than two. */
export function servedHostname(word: string): string | undefined {
  if (!isUrl(word)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(word);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.hostname === "" ? undefined : parsed.hostname;
}

/** What a bare address a person types looks like: a name or an IPv4 address with a port, or an IPv6 literal in its
 * brackets with one. The port is asked for because a wsp is reached at one and no default would be right for both
 * the app's own and one moved by --port. */
const BARE_ADDRESS = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):\d{1,5}$/;

/** The address typed on the join screen, as the road that dials it wants it: what a person reads off the other
 * computer is an authority (`192.168.1.20:4400`), which becomes an http address; an address that already carries
 * http or https is itself; anything else, a bare name with no port or a socket address, is nothing. One reading,
 * so the field that refuses a word and the dial that follows it cannot disagree about what an address is. */
export function joinAddressOf(typed: string): string | undefined {
  const word = typed.trim();
  if (/^https?:\/\//i.test(word)) return servedHostname(word) === undefined ? undefined : word;
  return BARE_ADDRESS.test(word) ? `http://${word}` : undefined;
}

/** An address and a port as the authority of a URL: an IPv6 literal needs brackets and everything else is itself.
 * The one rule, so the address wsp host pair prints and the one every local tool dials are spelled the same way. */
export function authority(address: string, port: number): string {
  const bracketed = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${bracketed}:${port}`;
}

/** Where a host a relay carries answers, written from the name the relay gave it: the one home for that spelling,
 * so a line that prints the address and a turn that dials it name the same one. A tunnel is TLS from end to end,
 * which is what makes the scheme a rule rather than a choice. */
export function relayUrlOf(hostname: string): string {
  return `https://${hostname}`;
}

/** The one line a host binding beyond this computer prints as it starts, so nobody learns from a stranger that the
 * page was reachable. */
export function listenBeyondLoopbackLine(address: string): string {
  return `listening on ${address}: anyone who can reach this computer there can load the page, and pairing is the gate. Run wsp host pair for a code, and wsp host devices to see who took one.`;
}

/** The line a host bound to one address beyond loopback prints as it starts: a thread on this computer reaches the
 * host at its loopback, so on that bind it is handed no token and starts nothing under itself. */
export function loopbackThreadsLine(address: string): string {
  return `listening on ${address} alone: threads on this computer start children only when the host also listens on loopback, so run wsp up with --listen 0.0.0.0 or 127.0.0.1 for them.`;
}

export interface AppPorts {
  /** The port the app is served on. */
  port: number;
  /** The port the runtime's WebSocket is served on. */
  wsPort: number;
}

/** A pair with whether a person named either port: a taken port somebody asked for is a refusal, where a taken
 * default is one wsp steps over. */
export interface PortsAsked extends AppPorts {
  named: boolean;
}

/** The pair with the address to bind them on, which is what a command line asked for and what wsp up serves; the
 * port stepping reads the pair alone, so it takes the narrower shape above. */
export interface ListenAsked extends PortsAsked {
  /** The address the host binds, as `--listen` named it or this computer alone. */
  address: string;
}

/** The one rule for the pair and the address, read by wsp up and wsp init: the app port as named or the default,
 * the WebSocket port as named or the app port plus the offset the defaults themselves sit apart, and the address as
 * named or this computer alone. Port 0 asks the operating system for any free port, and an offset above it would be
 * a privileged port, so that pair stays 0. */
export function portsAsked(flags: { port?: string; wsPort?: string; listen?: string }): ListenAsked {
  const port = flags.port !== undefined ? Number(flags.port) : DEFAULT_PORT;
  const derived = port === 0 ? 0 : port + WS_PORT_OFFSET;
  return {
    port,
    wsPort: flags.wsPort !== undefined ? Number(flags.wsPort) : derived,
    named: flags.port !== undefined || flags.wsPort !== undefined,
    address: flags.listen !== undefined && flags.listen !== "" ? flags.listen : LOOPBACK,
  };
}

/** What holds a port wsp wanted: a wsp host, named by the state file it serves, the process this computer could
 * name, or nothing it could name at all. */
export type PortProcess = { command: string; pid: number };
export type PortHolder = { statePath: string } | PortProcess | undefined;

/** Who holds a port, in the words every line about it uses. */
export function portHolderWords(holder: PortHolder): string {
  if (holder === undefined) return "another process";
  return "statePath" in holder ? `the host serving ${holder.statePath}` : `${holder.command} (pid ${holder.pid})`;
}

/** The sentence for a port a run was told to take and could not have. */
export function portTakenLine(port: number, holder: PortHolder): string {
  return `Port ${port} is in use on this computer by ${portHolderWords(holder)}.`;
}

/** What a run says when the default pair was taken and it stepped to a free one: the pair it serves on, then the
 * port it stepped over and who holds it, so a second setup beside a running host reads as a move and not a fault. */
export function portsPickedLine(ports: AppPorts, taken: number, holder: PortHolder): string {
  return `Serving on ${ports.port} and ${ports.wsPort}; ${taken} is held by ${portHolderWords(holder)}.`;
}

/** The last line when a port a person named is held: nothing has booted, and the two ways on. */
export const PORT_TAKEN_REFUSAL = `Nothing was booted. Stop that process, or name a free app port with --port; the WebSocket port follows ${WS_PORT_OFFSET} above it unless --ws-port names another.`;

/** The same last line where the run found a free pair above the held one: the line to type, spelled out, since a
 * person whose port is taken is guessing at numbers otherwise. Both ports are named only where the pair is not the
 * offset apart, which --port alone would not reproduce. */
export function portInsteadLine(ports: AppPorts): string {
  const flags = ports.wsPort === ports.port + WS_PORT_OFFSET ? `--port ${ports.port}` : `--port ${ports.port} --ws-port ${ports.wsPort}`;
  return `Nothing was booted. The next free pair is ${ports.port} and ${ports.wsPort}: wsp up ${flags}. Or stop what holds the one you named.`;
}

/** Which state file a run sets up and the flag that starts a fresh one instead: a run on a file that already
 * carries a sealed golden offers the upgrade rather than a first setup, so a showcase or a second account is one
 * flag rather than a surprise. Said before anything is read, and again in every refusal that stops the run. */
export function stateFileLine(statePath: string): string {
  return `Setting up ${statePath}; --state <path> starts a fresh setup instead.`;
}
