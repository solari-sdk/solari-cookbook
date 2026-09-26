// SPDX-License-Identifier: AGPL-3.0-only
// A remote server's icon as the host answers it, asked once per host for the
// whole window and never while the person's server icons switch is off. The
// page never fetches an icon itself: the host asks Google and hands back a
// data url, so no address a config names is ever loaded here.
import { useEffect } from "react";
import { create } from "zustand";
import { useStore } from "../../protocol/store.js";

interface IconsState {
  /** Each host's answer: a data url, or null for none. Absent until asked. */
  readonly of: Readonly<Record<string, string | null>>;
  put(host: string, icon: string | null): void;
}

const useIcons = create<IconsState>(set => ({
  of: {},
  put: (host, icon) => set(s => ({ of: { ...s.of, [host]: icon } })),
}));

const asking = new Set<string>();
/** Hosts a Read again dropped, whose next ask has the host ask Google again. */
const again = new Set<string>();

/** Every icon asked again at its next draw, which a Read again means. */
export function forgetServerIcons(): void {
  for (const host of Object.keys(useIcons.getState().of)) again.add(host);
  useIcons.setState({ of: {} });
}

export function useServerIcon(host: string | undefined): string | null {
  const on = useStore(s => s.preferences.serverIcons);
  const ask = useStore(s => s.api?.serversIcon);
  const icon = useIcons(s => (host === undefined ? undefined : s.of[host]));
  useEffect(() => {
    if (!on || host === undefined || ask === undefined || icon !== undefined || asking.has(host)) return;
    asking.add(host);
    const refresh = again.delete(host);
    // A refusal or a lost socket draws the glyph until a Read again asks once more.
    void ask(host, refresh)
      .then(
        answer => useIcons.getState().put(host, answer),
        () => useIcons.getState().put(host, null),
      )
      .finally(() => asking.delete(host));
  }, [on, host, ask, icon]);
  return on ? (icon ?? null) : null;
}

/** Drops every answer, for a test that starts from a fresh window. */
export function resetServerIcons(): void {
  asking.clear();
  again.clear();
  useIcons.setState({ of: {} });
}
