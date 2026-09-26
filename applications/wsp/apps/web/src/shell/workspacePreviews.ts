// SPDX-License-Identifier: AGPL-3.0-only
// A picture of the page for each workspace as the person last left it, for
// the switcher cards. Only the desktop shell can take one, so a browser tab's
// cards stay text, and it is never persisted: a page can hold a transcript,
// whose words belong to the machine and not to this computer's disk.
import { create } from "zustand";
import { desktopBridge } from "../lib/desktopShell.js";

interface WorkspacePreviewsState {
  images: Readonly<Record<string, string>>;
  /** Replaces every picture at once, so this side holds exactly what the shell answered and nothing the shell has
   * since dropped at its own cap. */
  setImages: (images: Readonly<Record<string, string>>) => void;
}

export const useWorkspacePreviews = create<WorkspacePreviewsState>(set => ({
  images: {},
  setImages: images => set({ images }),
}));

/** Asks the desktop shell to photograph the page for the workspace being left. It is asked for from inside the
 * store update that switches, before React has drawn the workspace arriving, so the picture is of the one leaving.
 * A browser tab has no such reach and its cards stay text. */
export function capturePagePreview(workspaceId: string): void {
  const capture = desktopBridge()?.capturePreview;
  if (capture === undefined) return;
  void capture(workspaceId).catch(() => undefined);
}

/** Reads back what the shell holds for the workspaces about to be drawn, and keeps that and nothing else. */
export async function loadPagePreviews(workspaceIds: ReadonlyArray<string>): Promise<void> {
  const read = desktopBridge()?.workspacePreview;
  if (read === undefined) return;
  const found = await Promise.all(
    workspaceIds.map(async workspaceId => [workspaceId, await read(workspaceId).catch(() => undefined)] as const),
  );
  const images: Record<string, string> = {};
  for (const [workspaceId, url] of found) if (url !== undefined) images[workspaceId] = url;
  useWorkspacePreviews.getState().setImages(images);
}
