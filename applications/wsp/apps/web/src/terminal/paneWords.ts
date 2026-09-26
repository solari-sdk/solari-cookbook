// SPDX-License-Identifier: AGPL-3.0-only
// The workspace-level words for a daemon link, read from the one state table:
// what a pane says over its frame, and the one line the main screen carries
// while the link is down. Both come from the same pane state, so the sidebar
// and a pane can never say two things about one link.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { isLocalWorkspace, type DaemonLinkStatus } from "@wsp/protocol";
import { linkDownLine, terminalPaneHints, terminalPaneState, type TerminalPaneState } from "../adapt/index.js";
import { useOutOfMemoryReading } from "../machine/live.js";
import { useAbsentComputer, useCapabilities, useStatus, useStore, useWorkspace, useWorkspaceState } from "../protocol/store.js";
import { getTerminals, NOT_OPENED_YET, onTerminals } from "./link.js";

/** The pane's state from the workspace's one vocabulary plus this link's socket and its last memory reading, the
 * lines under it, and the wake every pane offers. */
export function useTerminalPane(workspaceId: string, socket: DaemonLinkStatus, refusal: string | null = null): { pane: TerminalPaneState; hints: string[]; onWake: () => void } {
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  const capabilities = useCapabilities();
  const wake = useStore(s => s.wake);
  const phase = status?.phase ?? workspace?.phase ?? "running";
  const reach = status?.reach.state ?? null;
  const state = useWorkspaceState(workspaceId) ?? "running";
  const outOfMemory = useOutOfMemoryReading(workspaceId, phase);
  const local = workspace !== null && isLocalWorkspace(workspace);
  const absent = useAbsentComputer(workspaceId);
  // What this link's sentences name: the workspace, which on a machine wsp forked is that machine's own name.
  const where = workspace?.name ?? "";
  const pane = useMemo(() => terminalPaneState({ state, reach, socket, outOfMemory, refusal, local, absent, ...(where === "" ? {} : { where }) }), [state, reach, socket, outOfMemory, refusal, local, absent, where]);
  const size = status?.size ?? null;
  const sizes = capabilities?.sizes ?? null;
  const hints = useMemo(() => terminalPaneHints(pane, size, sizes), [pane, size, sizes]);
  const onWake = useCallback(() => void wake(workspaceId), [wake, workspaceId]);
  return { pane, hints, onWake };
}

const NEVER = (): (() => void) => () => {};

/** This workspace's link as the registry holds it, for a surface that draws no pane of its own. A workspace with no
 * model yet reads as a link nothing has been open on, which is what it is. */
export function useLinkSocket(workspaceId: string | null): { socket: DaemonLinkStatus; refusal: string | null } {
  const terms = useSyncExternalStore(onTerminals, () => (workspaceId === null ? null : getTerminals(workspaceId)));
  const subscribe = useCallback((fn: () => void) => terms?.onStatus(fn) ?? NEVER(), [terms]);
  const socket = useSyncExternalStore(subscribe, () => terms?.status() ?? NOT_OPENED_YET);
  const refusal = useSyncExternalStore(subscribe, () => terms?.refusal() ?? null);
  return { socket, refusal };
}

/** The word every git read over this workspace's wire keys on, so each reader asks again when the link changes it.
 * The wire is handed out before the link's first status lands, and a read made over a link that is not up yet comes
 * back unreachable: asked once, that failure stands as the reader's last word for the whole of a session, on a folder
 * it could read fine. The composer's folder row and the Diff pane's header both read the folder's branch, and both
 * key their read on this. */
export function useLinkWord(workspaceId: string | null): DaemonLinkStatus {
  return useLinkSocket(workspaceId).socket;
}

/** The one line the main screen shows while this workspace's link is down, else null. */
export function useLinkDownLine(workspaceId: string | null): string | null {
  const { socket, refusal } = useLinkSocket(workspaceId);
  const { pane } = useTerminalPane(workspaceId ?? "", socket, refusal);
  return workspaceId === null ? null : linkDownLine(pane);
}
