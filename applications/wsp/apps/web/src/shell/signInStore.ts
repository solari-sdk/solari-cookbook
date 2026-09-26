// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in pages a workspace asked to open. A page lives as long as its
// sign-in: keyed to the callback port the daemon named, it leaves when that
// port stops listening or the host closes its forward, or when the person
// dismisses it. A page with no port (a device-code flow) is one per
// workspace and leaves on Dismiss alone. Nothing opens without a click.
import { isHttpUrl } from "@wsp/protocol";
import { create } from "zustand";

export interface SignInPage {
  workspaceId: string;
  url: string;
  port?: number;
}

export interface SignInStoreState {
  pages: Record<string, SignInPage>;
  /** Only http(s) is kept: the machine is the untrusted side. */
  announce(workspaceId: string, url: string, port?: number): void;
  dismiss(key: string): void;
  /** The listener behind a callback port is gone, so the page it was waiting on is over. */
  portClosed(workspaceId: string, port: number): void;
  /** The workspace itself is gone: a bar left behind would name it by id. */
  forget(workspaceId: string): void;
}

const keyOf = (workspaceId: string, port: number | undefined): string => (port === undefined ? workspaceId : `${workspaceId}:${port}`);

export const useSignInStore = create<SignInStoreState>()(set => ({
  pages: {},
  announce(workspaceId, url, port) {
    if (!isHttpUrl(url)) return;
    const page: SignInPage = { workspaceId, url, ...(port !== undefined ? { port } : {}) };
    set(s => ({ pages: { ...s.pages, [keyOf(workspaceId, port)]: page } }));
  },
  dismiss(key) {
    set(s => {
      const { [key]: _gone, ...rest } = s.pages;
      return { pages: rest };
    });
  },
  portClosed(workspaceId, port) {
    set(s => {
      const { [keyOf(workspaceId, port)]: _gone, ...rest } = s.pages;
      return { pages: rest };
    });
  },
  forget(workspaceId) {
    set(s => ({ pages: Object.fromEntries(Object.entries(s.pages).filter(([, p]) => p.workspaceId !== workspaceId)) }));
  },
}));
