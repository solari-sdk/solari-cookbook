// SPDX-License-Identifier: AGPL-3.0-only
// Fills the terminal registry from the store: one WorkspaceTerminals per
// workspace for as long as it exists, one daemon link while it runs and the
// host's own socket is live. A napping workspace keeps its model (tabs,
// scrollback mirror) with the channel down; wake dials again and the model
// re-attaches its ptys. The same link is the browser's only source of ports:
// the daemon pushes port events only to sockets that asked with ports.watch,
// and a subscription dies with the channel, so every live transition asks again.
// This computer's own terminal, readings and processes ride a link of their
// own, to its daemon by place.
import { daemonVersionOf, HERE_PLACE_ID, readingRoad, workspaceKind, type DaemonLinkStatus } from "@wsp/protocol";
import { getBrowser } from "../browser/model.js";
import { provideDaemonHello, provideDaemonWire } from "../files/wire.js";
import { errorText } from "../lib/utils.js";
import { getLive } from "../machine/live.js";
import { getProcs } from "../machine/procs.js";
import type { Api } from "../protocol/client.js";
import type { useStore } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { paneOf } from "../panes.js";
import { useSignInStore } from "../shell/signInStore.js";
import { connectDaemonLink, type DaemonLink, type DaemonLinkOptions } from "./daemon-link.js";
import { HERE_KEY } from "./computer.js";
import { selectTerminalUiState, useTerminalDrawerStore } from "./drawerStore.js";
import { NOT_OPENED_YET, provideTerminals, WorkspaceTerminals, type TerminalWire } from "./link.js";

export interface WiringOptions extends Pick<DaemonLinkOptions, "heartbeatMs" | "backoffMs"> {
  /** Keystrokes reach the runtime as one workspaces.touch per this window; the idle window is minutes, so 30 s loses nothing. */
  touchMinMs?: number;
}

interface Wired {
  wt: WorkspaceTerminals;
  link: DaemonLink | null;
  /** When the runtime last heard this workspace was typed into. */
  touched: number;
}

export function wireTerminals(store: typeof useStore, opts: WiringOptions = {}): () => void {
  const wired = new Map<string, Wired>();
  const { touchMinMs = 30_000, ...linkOpts } = opts;

  const unlink = (entry: Pick<Wired, "link">): void => {
    entry.link?.close();
    entry.link = null;
  };

  // This computer's own terminal: its model is there from the start so the drawer has one to read, and its daemon
  // is dialled only once that drawer or a pane that reads it has been opened, since the host starts the daemon on
  // the first dial.
  const hereWire: TerminalWire = { request: (op, params) => (here.link ? here.link.request(op, params) : Promise.reject(new Error("daemon unreachable"))) };
  const here: Pick<Wired, "link" | "wt"> = { link: null, wt: new WorkspaceTerminals(hereWire) };
  provideTerminals(HERE_KEY, here.wt);
  provideDaemonWire(HERE_KEY, hereWire);
  let hereWanted = false;
  const hereStatus = (s: DaemonLinkStatus): void => {
    getLive(HERE_KEY).feedStatus(s);
    getProcs(HERE_KEY).feedStatus(s);
  };
  const syncHere = (api: Api, hostUp: boolean): void => {
    hereWanted ||=
      selectTerminalUiState(useTerminalDrawerStore.getState().byWorkspaceId, HERE_KEY).terminalOpen ||
      ((panel => panel?.isOpen === true && panel.surfaces.some(s => s.id === panel.activeSurfaceId && paneOf(s.kind).readsHere === true))(useRightPanelStore.getState().byWorkspaceId[HERE_KEY]));
    if (hostUp && hereWanted && !here.link) {
      const link = connectDaemonLink({
        ...linkOpts,
        daemon: api.daemon,
        target: { placeId: HERE_PLACE_ID },
        wasLive: here.wt.everLive(),
        onEvent: e => {
          if (e.type === "sys.sample") getLive(HERE_KEY).feedSample(e);
          else if (e.type === "proc.snapshot") getProcs(HERE_KEY).feedSnapshot(e);
          else here.wt.feedEvent(e);
        },
        onStatus: (s, refusal) => {
          if (s === "live")
            link.request("sys.watch").then(
              () => getLive(HERE_KEY).feedUnavailable(null),
              (e: unknown) => getLive(HERE_KEY).feedUnavailable(errorText(e)),
            );
          if (s !== "dead") {
            here.wt.feedStatus(s, refusal);
            hereStatus(s);
          }
        },
      });
      here.link = link;
    } else if (!hostUp && here.link) {
      unlink(here);
      const parked: DaemonLinkStatus = here.wt.everLive() ? "connecting" : NOT_OPENED_YET;
      here.wt.feedStatus(parked);
      hereStatus(parked);
    }
  };

  const sync = (): void => {
    const { api, workspaces, conn } = store.getState();
    if (!api) return;
    // Every channel rides the host's socket, so a host socket that is not live is a workspace that is not running:
    // the links are parked rather than left typing into channels the redial has already taken away.
    const hostUp = conn === "live";
    const seen = new Set<string>();
    for (const w of workspaces) {
      seen.add(w.id);
      let entry = wired.get(w.id);
      if (!entry) {
        const fresh: Wired = { link: null, touched: 0, wt: undefined as unknown as WorkspaceTerminals };
        const wire: TerminalWire = {
          request: (op, params) => {
            if (op === "pty.write" && Date.now() - fresh.touched >= touchMinMs) {
              fresh.touched = Date.now();
              store.getState().api?.touch?.(w.id).catch(() => {});
            }
            return fresh.link ? fresh.link.request(op, params) : Promise.reject(new Error("daemon unreachable"));
          },
        };
        fresh.wt = new WorkspaceTerminals(wire);
        entry = fresh;
        wired.set(w.id, entry);
        provideTerminals(w.id, entry.wt);
        provideDaemonWire(w.id, wire);
      }
      const { wt } = entry;
      // Whose reading the Live rows wait on: this computer's own are read in the host and arrive on the page's
      // socket (machine/hostLive.ts), so asking its daemon for the same stream would set a second sampler going on
      // the same machine and put a link's health over figures that do not ride that link.
      const sysFromDaemon = readingRoad(workspaceKind(w), "metrics") === "daemon";
      const up = w.phase === "running" && hostUp;
      if (up && !entry.link) {
        const browser = getBrowser(w.id);
        const link = connectDaemonLink({
          ...linkOpts,
          daemon: api.daemon,
          target: { workspaceId: w.id },
          wasLive: wt.everLive(),
          onEvent: e => {
            if (e.type === "port.open" || e.type === "port.close") {
              browser.feedEvent({ ...e, workspaceId: w.id });
              if (e.type === "port.close") useSignInStore.getState().portClosed(w.id, e.port);
            } else if (e.type === "browser.open") useSignInStore.getState().announce(w.id, e.url, e.port);
            else if (e.type === "daemon.hello") provideDaemonHello(w.id, { root: e.root, version: daemonVersionOf(e) });
            else if (e.type === "sys.sample") getLive(w.id).feedSample(e);
            else if (e.type === "proc.snapshot") getProcs(w.id).feedSnapshot(e);
            else wt.feedEvent(e);
          },
          // "dead" is the link we closed on purpose; the model keeps the word it had instead.
          onStatus: (s, refusal) => {
            if (s === "live") {
              link.request("ports.watch").then(r => browser.syncPorts(r["ports"]), () => {});
              if (sysFromDaemon)
                link.request("sys.watch").then(
                  () => getLive(w.id).feedUnavailable(null),
                  (e: unknown) => getLive(w.id).feedUnavailable(errorText(e)),
                );
            }
            if (s !== "dead") {
              wt.feedStatus(s, refusal);
              if (sysFromDaemon) getLive(w.id).feedStatus(s);
              getProcs(w.id).feedStatus(s);
            }
          },
        });
        entry.link = link;
      } else if (!up && entry.link) {
        // The model keeps its tabs and their scrollback across a park, so what a person is waiting on is what the
        // model has been and not how old this link object is: one that has been live is coming back, one that never
        // was is still starting.
        const parked: DaemonLinkStatus = wt.everLive() ? "connecting" : NOT_OPENED_YET;
        unlink(entry);
        wt.feedStatus(parked);
        if (sysFromDaemon) getLive(w.id).feedStatus(parked);
        getProcs(w.id).feedStatus(parked);
      }
    }
    syncHere(api, hostUp);
    for (const [id, entry] of wired) {
      if (seen.has(id)) continue;
      unlink(entry);
      wired.delete(id);
      provideTerminals(id, null);
      provideDaemonWire(id, null);
      provideDaemonHello(id, null);
      useSignInStore.getState().forget(id);
    }
  };

  const unsubscribe = store.subscribe(sync);
  const unsubscribeDrawer = useTerminalDrawerStore.subscribe(sync);
  const unsubscribePanel = useRightPanelStore.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    unsubscribeDrawer();
    unsubscribePanel();
    unlink(here);
    provideTerminals(HERE_KEY, null);
    provideDaemonWire(HERE_KEY, null);
    for (const [id, entry] of wired) {
      unlink(entry);
      provideTerminals(id, null);
      provideDaemonWire(id, null);
      provideDaemonHello(id, null);
    }
    wired.clear();
  };
}
