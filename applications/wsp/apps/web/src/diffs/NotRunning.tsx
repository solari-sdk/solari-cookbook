// SPDX-License-Identifier: AGPL-3.0-only
// What the Diff pane holds while there is no daemon to read a diff over: the
// computer's own sentence and the button that puts a daemon this host started
// back, else the one line that says the workspace is not running.
import { DaemonDown } from "../components/DaemonDown.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { useAbsentComputer } from "../protocol/store.js";

export function NotRunning({ workspaceId }: { workspaceId: string }) {
  const absent = useAbsentComputer(workspaceId);
  if (absent !== null && absent.start !== undefined) {
    return (
      <Empty className="flex-1">
        <DaemonDown absent={absent} workspaceId={workspaceId} />
      </Empty>
    );
  }
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>The task is not running.</EmptyTitle>
        <EmptyDescription>{absent?.sentence ?? "A diff is read over the task's daemon; wake it to read one."}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
