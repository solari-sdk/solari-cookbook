// SPDX-License-Identifier: AGPL-3.0-only
// The wsp tools an agent calls from inside its own turn, and the one fact a
// reader outside the host needs about a call still in flight: which thread it
// is behind. A call that follows another thread to the end of its turn cannot
// finish while that thread stands on a question, so the thread making the call
// is stopped on that question too.
import { serverTool } from "./format.js";

/** The name the wsp MCP server has in every agent's config and in every launch that carries it, so an agent's
 * config on this computer and the launch a turn on a machine gets name one server and not two. */
export const MCP_SERVER_NAME = "wsp";

/** Where each wsp call that does not answer until another thread's turn is over names the thread it is behind: the
 * input field holding the references, or `opened` for the call that follows the thread it starts, which has no id
 * until the call has made one. Adding a verb that blocks is a row here and nothing else. */
const FOLLOWS: Readonly<Record<string, { readonly field: string } | { readonly opened: true }>> = {
  send: { field: "thread" },
  run: { opened: true },
  threads_wait: { field: "threads" },
};

/** What a thread's running tool call is waiting behind, read off the call alone: the threads it named, by whatever
 * reference the caller used, or `opened` for a call that follows the thread it started. Nothing for another
 * server's tool, for a wsp verb that answers out of the host alone, and for a detached call, which answers the
 * moment the turn starts and follows nobody. */
export function threadsFollowed(call: { toolName: string; input: string }): { readonly named: readonly string[] } | { readonly opened: true } | undefined {
  const named = serverTool(call.toolName);
  if (named?.server !== MCP_SERVER_NAME) return undefined;
  const follows = FOLLOWS[named.tool];
  if (follows === undefined) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(call.input);
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null) return undefined;
  const args = input as Record<string, unknown>;
  if (args["detach"] === true) return undefined;
  if ("opened" in follows) return follows;
  const value = args[follows.field];
  const refs = (Array.isArray(value) ? value : [value]).filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  return refs.length === 0 ? undefined : { named: refs };
}
