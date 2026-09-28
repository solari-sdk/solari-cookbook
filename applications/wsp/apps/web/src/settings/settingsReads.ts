// SPDX-License-Identifier: AGPL-3.0-only
// The reads the settings pages draw from, made once while Settings is open
// and kept in the settings store: the host's setup (which keys it holds and
// the agents here), the Ghostty file's size, the account, the devices, the
// image and what each place has taken this month. One reader, so two pages
// asking for one record at one mount cannot ask the host twice, and the
// sidebar's search reads the same answers. The one door that moves the page
// rather than reading anything lands here too, since this is what the page
// mounts once.
import { useCallback, useEffect, useRef } from "react";
import { PLACES_TICKET_REFUSAL } from "@wsp/protocol";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { appScheme } from "../terminal/ghosttyConfig.js";
import { useSettingsAt } from "./settingsContext.js";
import { groupOf, useSettingsStore } from "./settingsStore.js";

export function useSettingsReads(): void {
  const api = useStore(s => s.api);
  const addComputerOpen = useStore(s => s.addComputerOpen);
  const devicesAsked = useSettingsStore(s => s.devicesAsked);
  const setReads = useSettingsStore(s => s.setReads);
  const onAbout = groupOf(useSettingsAt()) === "about";
  const asking = useRef(false);
  /** Set when this window may not read the money at all, so it stops asking at every tick. Only that refusal sets
   * it: a read dropped while the socket reconnects is asked again at the next tick. */
  const refused = useRef(false);

  // The Add a computer door moves the page rather than standing over it: the sheet is asked for from the first run
  // and from the palette as well as from the list, and closing it on whatever page was remembered hid the new row.
  useEffect(() => {
    if (addComputerOpen) useSettingsStore.getState().go({ kind: "group", group: "computers" });
  }, [addComputerOpen]);

  useEffect(() => {
    let live = true;
    void api?.initGet?.().then(
      setup => {
        if (live) setReads({ setup });
      },
      () => {
        if (live) setReads({ setup: null });
      },
    );
    void api?.hostTerminalConfig?.(appScheme()).then(
      file => {
        if (live) setReads({ file });
      },
      () => {},
    );
    void api?.account?.().then(
      account => {
        if (live) setReads({ account });
      },
      () => {
        if (live) setReads({ account: null });
      },
    );
    return () => {
      live = false;
    };
  }, [api, setReads]);

  useEffect(() => {
    let live = true;
    void api?.devicesList?.().then(
      devices => {
        if (live) setReads({ devices, devicesRefused: false });
      },
      () => {
        // The one refusal a page served on a ticket socket gets; anything else reads as no answer yet.
        if (live) setReads({ devices: null, devicesRefused: true });
      },
    );
    return () => {
      live = false;
    };
  }, [api, devicesAsked, setReads]);

  // Each opening of About asks the host to read the newest release again; the host's floor keeps that to one ask.
  useEffect(() => {
    if (onAbout) void api?.releaseCheck?.().then(release => useStore.setState({ release }), () => {});
  }, [api, onAbout]);

  const readImage = useCallback((): void => {
    void api?.image?.().then(
      image => setReads({ image }),
      () => {},
    );
  }, [api, setReads]);
  // Read when the page opens, and again on every sealed frame below, since a seal anywhere files a copy the page has
  // not read.
  useEffect(() => {
    readImage();
  }, [readImage]);

  const readSpend = useCallback((): void => {
    if (api?.spend === undefined || asking.current || refused.current) return;
    asking.current = true;
    void api
      .spend()
      .then(
        spend => setReads({ spend }),
        (e: unknown) => {
          if (e instanceof Error && e.message.includes(PLACES_TICKET_REFUSAL)) refused.current = true;
        },
      )
      .finally(() => {
        asking.current = false;
      });
  }, [api, setReads]);
  useEffect(readSpend, [readSpend]);
  // Every cost tick moves what a place has taken, so the figures follow the meter rather than the page being
  // reopened; the read in flight is what keeps a tick a workspace and a tick a second from asking twice at once.
  useProtocolEvents(
    useCallback(
      e => {
        if (e.type === "workspace.cost") readSpend();
        if (e.type === "golden.stage" && e.stage === "sealed") readImage();
      },
      [readSpend, readImage],
    ),
  );
}
