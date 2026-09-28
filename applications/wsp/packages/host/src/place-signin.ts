// SPDX-License-Identifier: AGPL-3.0-only
// A sign-in run on a computer's own terminal and shown in this one: the line
// the host planned for it there, a shared login's store pointed at the folder
// that computer's daemon keeps the logins its workspaces share, anything else
// as the owner of the home. The pty is that computer's own, reached through
// the host over the link it holds: nothing here dials it.
import { loginSignIn } from "@wsp/catalog";
import { lastLine, type AgentsTarget, type SignInLine } from "@wsp/protocol";
import { relayPty, runQuiet, type PtyLink, type RelayTerminal } from "./signin-relay.js";
import type { HostClient } from "./verbs.js";

/** The whole wait a sign-in on a computer you own gets: a person opens a page and types a code in it, which is
 * minutes rather than the two the build's own sign-ins are held to. */
export const BOX_SIGN_IN_MS = 10 * 60_000;
/** The tool's own status command afterwards, which reads a file and answers at once. */
const STATUS_MS = 20_000;

/** A pty on one computer the person owns, driven from this terminal: the frames ride the host's channel to the
 * daemon on that computer, and the events it pushes come back on the same channel. The close is the caller's. */
export interface PlaceLink {
  link: PtyLink;
  close(): Promise<void>;
}

/** Opens the channel and shapes it as the pty road takes it. The host refuses this to anything but its own
 * terminal and its own window, and answers with the computer's own sentence when it is not connected. */
export async function placeLink(client: HostClient, placeId: string): Promise<PlaceLink> {
  return targetLink(client, { placeId });
}

/** The same road to any target: a computer by its place id, or a workspace, whose daemon the host reads the road to. */
export async function targetLink(client: HostClient, target: AgentsTarget): Promise<PlaceLink> {
  const { channel } = await client.request<{ channel: string }>("daemon.open", target);
  const readers = new Set<(e: Record<string, unknown>) => void>();
  let gone: (() => void) | undefined;
  const closed = new Promise<void>(r => (gone = r));
  const off = client.onFrame(frame => {
    if (frame["channel"] !== channel) return;
    if (frame["type"] === "daemon.event") {
      const event = frame["event"];
      if (event !== null && typeof event === "object") for (const read of readers) read(event as Record<string, unknown>);
      return;
    }
    if (frame["type"] === "daemon.closed") gone?.();
  });
  void client.closed.then(() => gone?.());
  return {
    link: {
      op: async (op, extra) => (await client.request<{ reply: Record<string, unknown> }>("daemon.send", { channel, frame: { op, ...extra } })).reply,
      onEvent: fn => {
        readers.add(fn);
        return () => readers.delete(fn);
      },
      closed,
    },
    close: async () => {
      off();
      gone?.();
      await client.request("daemon.close", { channel }).catch(() => undefined);
    },
  };
}

export interface BoxSignIn {
  link: PtyLink;
  /** The agent whose own status says it landed; absent for one server's sign-in, which its exit says. */
  agent?: string;
  /** The line the host planned for where it runs: what runs first, the command, its environment and its status. */
  line: SignInLine;
  terminal: RelayTerminal;
  /** Opens a URL on this computer; the person presses o for it, as they do on a builder. */
  open(url: string): Promise<boolean>;
  timeoutMs?: number;
}

export interface BoxSignedIn {
  signedIn: boolean;
  /** Which of the tool's own login sources it says is in use, where its status says; nothing where it does not. */
  detail?: string;
  /** Why it is not signed in, in the tool's own words where it gave any. */
  said?: string;
}

/** Runs the sign-in the host planned on that computer's own terminal, shown here: what runs first, the command with
 * its environment rather than quoted into the line, then the tool's own status read the same way. Nothing is typed
 * here but what the person types. */
export async function relaySignIn(o: BoxSignIn): Promise<BoxSignedIn> {
  const { line } = o;
  if (line.prepare !== undefined) await o.link.op("exec", { cmd: line.prepare });
  const outcome = await relayPty({
    link: o.link,
    command: line.command,
    terminal: o.terminal,
    open: o.open,
    ...(line.env !== undefined ? { env: line.env } : {}),
    timeoutMs: o.timeoutMs ?? BOX_SIGN_IN_MS,
  });
  const row = o.agent === undefined ? undefined : loginSignIn(o.agent);
  const check = row?.status;
  if (check === undefined || line.status === undefined) return { signedIn: outcome.exitCode === 0 };
  const status = await runQuiet(o.link, line.status, STATUS_MS, line.env ?? {});
  const signedIn = check.signedIn(status.output, status.exitCode);
  const detail = check.detail?.(status.output, new Map());
  return {
    signedIn,
    ...(signedIn && detail !== undefined ? { detail } : {}),
    ...(!signedIn ? { said: check.why?.(status.output) ?? lastLine(status.output) } : {}),
  };
}
