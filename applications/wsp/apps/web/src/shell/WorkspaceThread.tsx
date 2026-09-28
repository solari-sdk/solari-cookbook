// SPDX-License-Identifier: AGPL-3.0-only
// The center thread for one workspace: the chat view with the composer in
// its slot. The composer is keyed by workspace so the editor and its undo
// history remount on a switch; the draft store keeps each workspace's text.
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatView } from "../components/chat/ChatView.js";

export function WorkspaceThread({ workspaceId, threadId = null }: { workspaceId: string; threadId?: string | null }) {
  return (
    <ChatView workspaceId={workspaceId} threadId={threadId}>
      {thread => <ChatComposer key={workspaceId} workspaceId={workspaceId} thread={thread} />}
    </ChatView>
  );
}
