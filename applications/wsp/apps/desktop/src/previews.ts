// SPDX-License-Identifier: AGPL-3.0-only
// The page as a picture, one per workspace, held only in this process's
// memory: nothing is written to disk, since a workspace's page can hold a
// transcript. A capture replaces what that workspace held, and the oldest
// leaves once the cap is reached, so a long session cannot grow without end.
const PREVIEW_WIDTH = 480;
const PREVIEW_CAP = 12;

/** The part of Electron's NativeImage this needs; a fake stands in for it under test. */
export interface PageImage {
  resize(options: { width: number }): PageImage;
  toDataURL(): string;
}

/** The part of a WebContents this needs. */
export interface CapturablePage {
  capturePage(): Promise<PageImage>;
}

export interface PagePreviews {
  capture(workspaceId: string, page: CapturablePage): Promise<void>;
  get(workspaceId: string): string | undefined;
}

export function pagePreviews(width = PREVIEW_WIDTH, cap = PREVIEW_CAP): PagePreviews {
  const byWorkspaceId = new Map<string, string>();
  return {
    async capture(workspaceId, page) {
      const image = await page.capturePage();
      const url = image.resize({ width }).toDataURL();
      byWorkspaceId.delete(workspaceId);
      byWorkspaceId.set(workspaceId, url);
      for (const oldest of byWorkspaceId.keys()) {
        if (byWorkspaceId.size <= cap) break;
        byWorkspaceId.delete(oldest);
      }
    },
    get: workspaceId => byWorkspaceId.get(workspaceId),
  };
}
