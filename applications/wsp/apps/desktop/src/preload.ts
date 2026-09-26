// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentHere, InstallReport } from "@wsp/host";
import type { BundleOutcome, ContextMenuItem, DesktopBridge, HostOutcome, HostsView, InitNeedsYou, LocalFontFace, ShellChord, ThemePreference } from "@wsp/protocol";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { shellArgFrom } from "./shell-args.js";

/** What the first launch's page can ask the shell, answered only while that page is up. */
export interface OnboardingBridge {
  /** The catalog's agents as this computer has them, from the recipe scan's own detector. */
  agents(): Promise<AgentHere[]>;
  /** Writes the wsp server and skill into each named agent's own config. */
  install(ids: string[]): Promise<InstallReport>;
  /** Records this computer as the workspace and opens the app on it; the page's window closes once the app's is up. */
  finish(): Promise<void>;
}

const bridge: DesktopBridge & OnboardingBridge = {
  version: shellArgFrom(process.argv, "version"),
  bundleHover: shellArgFrom(process.argv, "bundle-hover"),
  agents: () => ipcRenderer.invoke("onboarding:agents"),
  install: (ids: string[]): Promise<InstallReport> => ipcRenderer.invoke("onboarding:install", ids),
  finish: () => ipcRenderer.invoke("onboarding:finish"),
  hostToken: (): Promise<string | undefined> => ipcRenderer.invoke("hosts:token"),
  hosts: (): Promise<HostsView> => ipcRenderer.invoke("hosts:list"),
  switchHost: (alias: string | null): Promise<HostOutcome> => ipcRenderer.invoke("hosts:switch", alias),
  getBundle: (ask: { version: string }): Promise<BundleOutcome> => ipcRenderer.invoke("bundle:get", ask),
  quitAndOpen: (): Promise<BundleOutcome> => ipcRenderer.invoke("bundle:open"),
  localFonts: (family: string): Promise<LocalFontFace[]> => ipcRenderer.invoke("fonts:local", family),
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("folder:pick"),
  // Answered here rather than over a handler, since only the preload can read the path off a dropped file; the
  // shell is asked first, so a page served by a host somewhere else is handed nothing from this computer.
  droppedPath: (file: File): string | undefined => (ipcRenderer.sendSync("drop:allowed") === true ? webUtils.getPathForFile(file) : undefined),
  contextMenu: (items: ContextMenuItem[]): Promise<string | null> => ipcRenderer.invoke("menu:context", items),
  capturePreview: (workspaceId: string): Promise<void> => ipcRenderer.invoke("preview:capture", workspaceId),
  workspacePreview: (workspaceId: string): Promise<string | undefined> => ipcRenderer.invoke("preview:read", workspaceId),
  setTerminalFocus: (focused: boolean): void => ipcRenderer.send("terminal:focus", focused),
  onShellChord: (handler: (chord: ShellChord) => void): (() => void) => {
    const listen = (_event: unknown, chord: ShellChord): void => handler(chord);
    ipcRenderer.on("shell:chord", listen);
    return () => ipcRenderer.off("shell:chord", listen);
  },
  setTheme: (theme: ThemePreference): void => ipcRenderer.send("theme:set", theme),
  needsYou: (need: InitNeedsYou): void => ipcRenderer.send("needs-you:say", need),
  onNeedsYouOpen: (handler: () => void): (() => void) => {
    const listen = (): void => handler();
    ipcRenderer.on("needs-you:open", listen);
    return () => ipcRenderer.off("needs-you:open", listen);
  },
};

contextBridge.exposeInMainWorld("wsp", bridge);

const htmlClass = shellArgFrom(process.argv, "html-class");
if (htmlClass !== undefined) {
  // The preload runs before the parser has made the html element, so the class waits for it.
  new MutationObserver((_, observer) => {
    if (document.documentElement === null) return;
    document.documentElement.classList.add(htmlClass);
    observer.disconnect();
  }).observe(document, { childList: true });
}
