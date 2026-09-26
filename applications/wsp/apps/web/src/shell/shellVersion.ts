// SPDX-License-Identifier: AGPL-3.0-only
// The desktop shell and this page are two halves of one release that can be
// run apart: an app attached to a host it did not start may be of another
// build, and then every call over the bridge (a dropped folder, the folder
// picker, the computer's fonts, a page photograph, the native menu) works or
// fails by which half is behind, with nothing said. Read once on load and put
// in the one place the app already puts a sentence a person may be waiting on.
import { GET_THE_APP_WORD, releaseAbove, shellVersionNotice, type ReleaseLatest, type ReleaseView } from "@wsp/protocol";
import { useEffect } from "react";
import { RELEASES } from "../../../../packages/wspx/scripts/bundles.mjs";
import { bootPayload } from "../boot.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { addNotice } from "../notices/store.js";

/** Both halves as this page can read them: the shell holding it, when a shell does, and the host that served it.
 * The settings page shows them side by side; a browser tab has no shell half to show. */
export function shellVersions(): { app: string | undefined; host: string | undefined; inShell: boolean } {
  const bridge = desktopBridge();
  return { app: bridge?.version, host: bootPayload()?.version, inShell: bridge !== undefined };
}

/** The release this page's app or host is behind, or nothing: what About's Latest ink, its buttons, the settings
 * sidebar's word and the update notice all read, so none of them can disagree. */
export function releaseAhead(release: ReleaseView | null, versions: ReturnType<typeof shellVersions>): ReleaseLatest | undefined {
  if (release === null) return undefined;
  const running = [versions.host, versions.inShell ? versions.app : undefined].filter((version): version is string => version !== undefined);
  return releaseAbove(release, ...running) ? release.latest : undefined;
}

/** Mounted once under the store: a shell of another release than the host that served this page is a notice,
 * with the releases page behind its button where there is a newer app to get. */
export function useShellVersionEffect(): void {
  useEffect(() => {
    const { app, host, inShell } = shellVersions();
    if (!inShell || host === undefined) return;
    let live = true;
    // On a host somewhere else the sentence names it, so a person with two hosts knows which one is behind.
    const say = (label?: string): void => {
      const notice = shellVersionNotice(app, host, label);
      if (notice === undefined || !live) return;
      addNotice({ kind: "note", text: notice.line, ...(notice.update ? { action: { word: GET_THE_APP_WORD, run: () => void window.open(RELEASES, "_blank", "noopener,noreferrer") } } : {}) });
    };
    const hosts = desktopBridge()?.hosts;
    if (hosts === undefined) {
      say();
      return;
    }
    hosts().then(view => say(view.hosts.find(h => h.alias === view.current)?.alias), () => say());
    return () => {
      live = false;
    };
  }, []);
}
