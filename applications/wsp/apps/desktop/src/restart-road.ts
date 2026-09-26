// SPDX-License-Identifier: AGPL-3.0-only
// The app's host runs inside the app's own process, so the app restarts it by
// relaunching itself: the quit closes the host and its lock through
// before-quit, and the relaunch starts the bundle at process.execPath, which
// is the new one once the app was replaced under a running copy.
import type { RestartRoad } from "@wsp/host";

export interface Relauncher {
  relaunch(): void;
  quit(): void;
}

export const appRestartRoad = (app: Relauncher): RestartRoad => ({
  shape: "app",
  restart: async () => {
    app.relaunch();
    app.quit();
  },
});
