// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the pane for this computer's own daemon
// while it is not running, in either theme (?theme=light), over a fake api
// whose start the host refuses with a long sentence that has to wrap.
import { createRoot } from "react-dom/client";
import { ownDaemonDown } from "@wsp/protocol";
import { DaemonDown } from "../../src/components/DaemonDown";
import { RequestError, type Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const REFUSED = "wsp-daemon at /Users/maya/Library/wsp_daemon_release_builds_2026_09_24_x86_64_unknown_linux_musl_bin/wsp_daemon exited at once: address 127.0.0.1:4640 already in use";
useStore.setState({
  api: {
    subscribe: () => () => {},
    restartDaemon: async () => {
      throw new RequestError(REFUSED);
    },
  } as unknown as Api,
});

createRoot(document.getElementById("root")!).render(
  <div className="flex h-full bg-background">
    <div className="mx-auto flex w-[420px] flex-col px-6" data-k="pane">
      <DaemonDown absent={ownDaemonDown("this Mac")} workspaceId="ws_mac" />
    </div>
  </div>,
);
