// SPDX-License-Identifier: AGPL-3.0-only
// The last line of the sidebar in the desktop shell: which host this window
// is on, in mono and muted, with the one glyph that says it is a menu. The
// menu is the shell's own, drawn from the same rows the menu bar's Hosts menu
// is, so the two can never list different hosts. A browser tab has no shell
// to move between hosts and draws nothing.
import { useCallback, useEffect, useState } from "react";
import { HOST_WORDS, hostMenuAction, hostsMenuItems, type HostsView } from "@wsp/protocol";
import { ChevronsUpDownIcon } from "lucide-react";
import { desktopBridge } from "../lib/desktopShell.js";
import { addNotice } from "../notices/store.js";
import { FOOT_ROW_CLASS } from "../sidebar/rowGrammar.js";

const HOSTS_NOT_READ = "hosts not read";

export function HostFoot() {
  const bridge = desktopBridge();
  const [view, setView] = useState<HostsView | null>(null);
  const [refused, setRefused] = useState(false);
  const hosts = bridge?.hosts;
  const reload = useCallback(() => {
    void hosts?.().then(
      next => {
        setView(next);
        setRefused(false);
      },
      () => {
        setView(null);
        setRefused(true);
      },
    );
  }, [hosts]);
  useEffect(reload, [reload]);
  if (hosts === undefined) return null;
  const label = view === null ? (refused ? HOSTS_NOT_READ : "") : view.current ?? view.here;
  const openMenu = async (): Promise<void> => {
    if (view === null || bridge?.contextMenu === undefined) return;
    const chosen = await bridge.contextMenu(hostsMenuItems(view));
    const action = chosen === null ? undefined : hostMenuAction(chosen);
    if (action === undefined) return;
    const answer = (await bridge.switchHost?.(action.alias)) ?? { ok: true };
    if (!answer.ok) addNotice({ kind: "error", text: answer.error });
    reload();
  };
  return (
    <div data-host-foot className="px-1 pb-1">
      <button
        type="button"
        aria-label={HOST_WORDS.hosts}
        onClick={() => void openMenu()}
        className={FOOT_ROW_CLASS}
      >
        <span data-host-label className="min-w-0 flex-1 truncate text-left">
          {label}
        </span>
        {view === null ? null : <ChevronsUpDownIcon aria-hidden className="size-4 shrink-0" />}
      </button>
    </div>
  );
}
