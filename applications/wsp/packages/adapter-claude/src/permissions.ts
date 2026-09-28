// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code's side of the permission prompt: the control channel that rides
// the same stream-json pair a turn already uses. The CLI raises a prompt as a
// control_request with subtype can_use_tool on stdout and blocks the tool call
// until a control_response with the same request_id comes back on stdin
// (measured on 2.1.263, 2026-09-08: --permission-mode default alone denies
// every such call by itself and prints system/permission_denied; the prompts
// reach this process only with --permission-prompt-tool stdio, which is what
// the CLI's own --permission-prompts host means by "the SDK host"). Either
// side may withdraw one of its own in-flight requests with a
// control_cancel_request, which the CLI sends for a prompt whose turn was
// interrupted. A control_request this file does not know is answered with an
// error rather than left unanswered, since the CLI waits on every one it sends.
// The channel runs both ways: set_permission_mode is this host's own request,
// and the CLI answers it with a control_response carrying the request's id.

import { PERMISSION_ALLOW, PERMISSION_DENY, pickedOptions, questionAnswerInput, questionOptions } from "@wsp/protocol";
import type { PermissionAsk, PermissionOption } from "@wsp/protocol";

/** The one flag that routes the CLI's permission prompts to this process instead of having it deny them itself. */
export const PERMISSION_PROMPT_TOOL = "stdio";

/** The mode this CLI takes as a launch flag alone (--dangerously-skip-permissions), which is why it refuses
 * set_permission_mode for it mid-turn. The launch reads this and so does the mid-turn pick, which answers the turn's
 * prompts here instead: the mode means nobody is asked, and a person who picked it while a prompt is open is asking
 * for that prompt to go too. */
export const SKIP_PROMPTS_MODE = "bypassPermissions";

/** A setMode suggestion's option id, so the runtime and the adapter name the same pick. */
const modeOptionId = (mode: string): string => `mode:${mode}`;

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** What one line of the CLI's stream is, as far as the control channel cares. */
export type ControlLine =
  /** `agentId` is the CLI's handle for the subagent whose run raised this, where one did; the caller turns it into
   * the tool call that launched that subagent, which is the only handle the rest of wsp knows it by. */
  | { kind: "ask"; ask: PermissionAsk; agentId?: string }
  | { kind: "cancel"; requestId: string }
  /** A control_request of a subtype this adapter does not answer; the CLI is told so it stops waiting. */
  | { kind: "unknown"; requestId: string; subtype: string }
  /** The CLI's answer to a request this adapter sent; `error` is its own words for one it would not take. */
  | { kind: "answer"; requestId: string; error?: string }
  | undefined;

/**
 * Reads a parsed stream line as a control-channel line, or nothing when it is an ordinary event. The options are
 * allow and deny always, in that order, then one per setMode suggestion the CLI made for this call, each labelled by
 * its own mode slug: the words for a mode live in the runtime's harness table, which an adapter does not read, so
 * the runtime relabels these on the way to the wire.
 */
export function controlLine(event: Record<string, unknown>): ControlLine {
  const type = str(event.type);
  if (type === "control_cancel_request") {
    const requestId = str(event.request_id);
    return requestId === undefined ? undefined : { kind: "cancel", requestId };
  }
  if (type === "control_response") {
    const response = rec(event.response);
    const requestId = str(response?.request_id);
    if (requestId === undefined) return undefined;
    const error = str(response?.subtype) === "error" ? str(response?.error) ?? "the CLI refused it without saying why" : undefined;
    return { kind: "answer", requestId, ...(error !== undefined ? { error } : {}) };
  }
  if (type !== "control_request") return undefined;
  const requestId = str(event.request_id);
  const request = rec(event.request);
  if (requestId === undefined || request === undefined) return undefined;
  const subtype = str(request.subtype) ?? "";
  if (subtype !== "can_use_tool") return { kind: "unknown", requestId, subtype };
  const toolName = str(request.tool_name);
  if (toolName === undefined) return { kind: "unknown", requestId, subtype };
  const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  const modes: PermissionOption[] = [];
  for (const raw of suggestions) {
    const suggestion = rec(raw);
    const mode = str(suggestion?.mode);
    if (suggestion === undefined || str(suggestion.type) !== "setMode" || mode === undefined) continue;
    if (modes.some((o: PermissionOption) => o.mode === mode)) continue;
    modes.push({ id: modeOptionId(mode), label: mode, effect: "mode", mode });
  }
  const detail = str(request.description);
  const toolUseId = str(request.tool_use_id);
  const agentId = str(request.agent_id);
  const input = JSON.stringify(request.input ?? null);
  // A call that only asks the person something carries the question's own choices and no allow: there is nothing to
  // consent to, and the CLI reads the pick off the input it hands back.
  const asked = questionOptions(toolName, input);
  return {
    kind: "ask",
    ...(agentId !== undefined ? { agentId } : {}),
    ask: {
      askId: requestId,
      toolName,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      input,
      ...(detail !== undefined && detail !== "" ? { detail } : {}),
      options:
        asked.length > 0
          ? asked
          : [
              { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
              { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
              ...modes,
            ],
    },
  };
}

/** One line of the stdin channel: the answer to a prompt, in the shape the CLI's control channel takes. A mode pick
 * is an allow that also carries the permission update the CLI suggested, which is how it stops asking for the rest
 * of the session. `input` is the tool's input as the ask carried it, handed back unchanged: the channel lets a host
 * rewrite it, and the one rewrite this host makes is the person's answer to a question, which the CLI reads off the
 * input rather than off the pick. */
export function controlAnswerLine(ask: PermissionAsk, optionId: string, denyMessage: string): string {
  const picked = pickedOptions(ask.options, optionId);
  const option = picked?.[0];
  if (picked === undefined || option === undefined) throw new Error(`${optionId} is not an option on this permission prompt`);
  const answered = option.effect === "answer" ? questionAnswerInput(ask.toolName, ask.input, picked.map(o => o.id)) : undefined;
  const updatedInput = answered ?? JSON.parse(ask.input) ?? {};
  const response =
    option.effect === "deny"
      ? { behavior: "deny", message: denyMessage }
      : option.effect === "mode"
        ? { behavior: "allow", updatedInput, updatedPermissions: [{ type: "setMode", mode: option.mode, destination: "session" }] }
        : { behavior: "allow", updatedInput };
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: ask.askId, response } });
}

/** The line that allows a call nobody was asked about: the turn is at a mode that asks nobody, so the prompt the CLI
 * raised is answered from here and no deny words exist for it. */
export function controlAllowLine(ask: PermissionAsk): string {
  return controlAnswerLine(ask, PERMISSION_ALLOW, "");
}

/** The option on an open prompt that allows this call and leaves the rest of the session in `mode`, where the CLI
 * suggested that mode for this call; nothing where it suggested another or none, and the prompt then stands for the
 * person as it did. */
export function modeOptionOn(ask: PermissionAsk, mode: string): string | undefined {
  return ask.options.find(o => o.effect === "mode" && o.mode === mode)?.id;
}

/** The request that puts a running turn into another access mode from its next tool call on: the same channel the
 * prompts ride, in the direction the SDK host writes. The CLI answers it with a control_response of this request's
 * own id. Measured on 2.1.263, 2026-09-08: every mode is taken mid-turn and the next tool call runs at it, except
 * bypass, which is refused with "the session was not launched with --dangerously-skip-permissions" because that mode
 * is a launch flag on this CLI; the turn still goes to that mode, with this host answering its prompts rather than
 * the CLI skipping them. */
export function setModeLine(requestId: string, mode: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "set_permission_mode", mode } });
}

/** The answer to a control_request this adapter cannot serve: the CLI stops waiting on it and says why in its log. */
export function controlErrorLine(requestId: string, subtype: string): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error: `wsp answers no ${subtype} control request` },
  });
}
