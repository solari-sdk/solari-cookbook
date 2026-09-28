// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useSyncExternalStore } from "react";
import { makeApi, ProtocolClient } from "./protocol/client.js";
import { useCreation, useFirstRun, useProjectsRead, useProjectsRefused, useReady, useSelectedId, useSelectedThreadId, useSettingsOpen, useStore } from "./protocol/store.js";
import { ComputerTerminalDrawer, WorkspaceTerminalDrawer } from "./components/WorkspaceTerminalDrawer.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { useThemeEffect } from "./settings/theme.js";
import { AppShell } from "./shell/AppShell.js";
import { MaterialTuner } from "./dev/MaterialTuner.js";
import { useHostNotices } from "./notices/hostNotices.js";
import { useShellVersionEffect } from "./shell/shellVersion.js";
import { FirstRun } from "./shell/FirstRun.js";
import { ProjectHome } from "./shell/ProjectHome.js";
import { WorkspaceCreation } from "./shell/WorkspaceCreation.js";
import { WorkspaceThread } from "./shell/WorkspaceThread.js";
import { wireHostLive } from "./machine/hostLive.js";
import { wireTerminals } from "./terminal/wiring.js";
import { Gallery } from "./gallery/Gallery.js";
import { PROJECT_WORDS } from "./sidebar/words.js";

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const readHash = () => window.location.hash;

/** What the page hands the app: where the runtime is, the token to open it with, and, for a token this browser was
 * paired with rather than the host's own, what to do when the host stops honouring it. */
export interface AppProps {
  wsUrl: string;
  token: string;
  onUnauthorized?: () => void;
}

/** #gallery mounts the ui kit proof page with no runtime behind it; every other hash is the app. */
export function Root(props: AppProps) {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  return hash === "#gallery" ? <Gallery /> : <App {...props} />;
}

export function App({ wsUrl, token, onUnauthorized }: AppProps) {
  const bind = useStore(s => s.bind);
  const setConn = useStore(s => s.setConn);
  const noteGap = useStore(s => s.noteGap);
  useEffect(() => {
    const client = new ProtocolClient({ url: wsUrl, token, onStatus: setConn, onGap: noteGap, ...(onUnauthorized !== undefined ? { onUnauthorized } : {}) });
    let live = true;
    // A refused token settles this rejected, and nothing else awaits it: the page hears about that through
    // onUnauthorized, so swallowing it here is what keeps a revoked device from faulting the renderer.
    void client.connect().then(
      () => { if (live) bind(makeApi(client)); },
      () => {},
    );
    return () => { live = false; client.close(); };
  }, [wsUrl, token, bind, setConn, noteGap, onUnauthorized]);
  useEffect(() => wireTerminals(useStore), []);
  useEffect(() => wireHostLive(useStore), []);
  useThemeEffect();
  useHostNotices();
  useShellVersionEffect();
  return <Shell />;
}

/** The center slot: the settings page while it is open, the first run while this wsp holds no project, else the
 * selected workspace's thread with the terminal drawer under it, or the creation in progress. With no workspace on
 * screen the drawer is this computer's own terminal. */
function WorkspaceCenter() {
  const workspaceId = useSelectedId();
  const threadId = useSelectedThreadId();
  const creation = useCreation(workspaceId);
  const settingsOpen = useSettingsOpen();
  const firstRun = useFirstRun();
  const projectsRead = useProjectsRead();
  const projectsRefused = useProjectsRefused();
  // With nothing picked the centre is a project's home, the one picked or the first, never a screen that asks to pick.
  const projectHome = useStore(s => s.projectHome ?? s.projects[0]?.id ?? null);
  if (settingsOpen) return <SettingsPage />;
  if (creation) return <WorkspaceCreation creation={creation} />;
  // Nothing recorded and nothing standing, both answered for: the first run is the whole centre, and it is the one
  // screen that records a project. A host that holds either says the rest, since a workspace with no project record
  // of its own is still work a person can open; one that has answered about neither yet says nothing at all.
  if (firstRun) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
          <FirstRun />
        </div>
        <ComputerTerminalDrawer />
      </>
    );
  }
  // A host that has not yet said what projects it holds says nothing here: the first run may still be the centre,
  // and either sentence painted now is replaced a round trip later.
  if (!workspaceId && !projectsRead) return null;
  // A refused list is not an empty one: the centre says why there is no project to open, as the sidebar does.
  if (!workspaceId && projectsRefused !== null) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" data-terminal-beside>
          <p data-k="centre-refused" className="max-w-md text-sm text-muted-foreground">
            {PROJECT_WORDS.notRead(projectsRefused.said)}
          </p>
        </div>
        <ComputerTerminalDrawer />
      </>
    );
  }
  if (!workspaceId && projectHome !== null) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
          <ProjectHome projectId={projectHome} />
        </div>
        <ComputerTerminalDrawer />
      </>
    );
  }
  if (!workspaceId) return null;
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
        <WorkspaceThread workspaceId={workspaceId} threadId={threadId} />
      </div>
      <WorkspaceTerminalDrawer workspaceId={workspaceId} />
    </>
  );
}

/** The window below the connection: the three-region shell, on this computer when nothing else is recorded yet. */
export function Shell() {
  const ready = useReady();
  return (
    <AppShell>
      {ready ? (
        <WorkspaceCenter />
      ) : (
        <div className="p-6 font-mono text-sm text-muted-foreground">connecting to runtime…</div>
      )}
      {import.meta.env.DEV ? <MaterialTuner /> : null}
    </AppShell>
  );
}
