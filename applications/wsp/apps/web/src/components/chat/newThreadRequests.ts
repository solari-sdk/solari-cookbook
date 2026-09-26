// SPDX-License-Identifier: AGPL-3.0-only
// Memory for wsp:new-thread requests. The window event only reaches live
// listeners, and the chat for the target workspace is often not mounted when
// it fires (the palette selects the workspace and requests in one handler;
// the shortcut fires with another tab active), so each request is held per
// workspace until a chat for it takes it. The listener installs when this
// module loads, which is with the shell through the static import chain from
// App to ChatView; a lazy chat tab would need it hoisted to keep hearing
// requests raised before the first chat mounts.
import { create } from "zustand";
import { onNewThreadRequest } from "../../shell/shellRequests";

interface NewThreadRequestsState {
  readonly pending: ReadonlySet<string>;
  readonly request: (workspaceId: string) => void;
  readonly take: (workspaceId: string) => boolean;
}

export const useNewThreadRequests = create<NewThreadRequestsState>()((set, get) => ({
  pending: new Set<string>(),
  request: workspaceId => {
    if (get().pending.has(workspaceId)) return;
    set(s => ({ pending: new Set(s.pending).add(workspaceId) }));
  },
  take: workspaceId => {
    if (!get().pending.has(workspaceId)) return false;
    set(s => {
      const pending = new Set(s.pending);
      pending.delete(workspaceId);
      return { pending };
    });
    return true;
  },
}));

if (typeof window !== "undefined") {
  onNewThreadRequest(({ workspaceId }) => useNewThreadRequests.getState().request(workspaceId));
}
