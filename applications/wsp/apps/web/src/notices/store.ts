// SPDX-License-Identifier: AGPL-3.0-only
// Every notice the app says away from where a person is looking: shown as a
// toast for a few seconds, kept in the list after it goes.
import { create } from "zustand";
import { failureOf } from "../protocol/failure.js";

export type NoticeKind = "error" | "done" | "waiting" | "note";

export interface NoticeAction {
  readonly word: string;
  readonly run: () => void;
}

export interface Notice {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly text: string;
  /** The computer or workspace it is about, drawn before the time. */
  readonly where?: string;
  /** Wall-clock ms. */
  readonly at: number;
  readonly action?: NoticeAction;
  /** A notice that stands for a wait: its toast stays until end(key), and a second add under the key replaces it. */
  readonly key?: string;
}

export type NoticeInput = Omit<Notice, "id" | "at">;

export const NOTICE_MS = 8_000;
export const NOTICE_WITH_ACTION_MS = 12_000;
export const NOTICE_CAP = 50;
/** As much of a sentence as a notice keeps; a refusal can echo the frame it was sent, as the host's log line cuts it. */
export const NOTICE_CHARS = 400;
/** Toasts on screen at once; a fourth sends the oldest to the list only. */
export const NOTICE_LIMIT = 3;

/** How long a notice's toast stands: a keyed one until its wait ends. */
export const noticeTimeout = (n: Notice): number => (n.key !== undefined ? 0 : n.action !== undefined ? NOTICE_WITH_ACTION_MS : NOTICE_MS);

interface NoticesState {
  /** Newest first. */
  notices: Notice[];
  /** The ids whose toast stands, oldest first. */
  toasts: string[];
  /** Added since the list was last opened. */
  unread: number;
  add(input: NoticeInput): string;
  /** Takes the toast off the screen; the row stays in the list. */
  dismiss(id: string): void;
  /** The wait a keyed notice stood for is over: its toast and its row go. */
  end(key: string): void;
  clear(): void;
  read(): void;
}

let seq = 0;

/** The newest toasts up to the limit; a keyed one stands for a wait, so the oldest plain one goes before it. */
function trimmed(toasts: string[], keyed: ReadonlySet<string>): string[] {
  const out = [...toasts];
  while (out.length > NOTICE_LIMIT) {
    const plain = out.findIndex(id => !keyed.has(id));
    out.splice(plain === -1 ? 0 : plain, 1);
  }
  return out;
}

export const useNotices = create<NoticesState>((set, get) => ({
  notices: [],
  toasts: [],
  unread: 0,
  add(input) {
    const id = `notice:${++seq}`;
    const text = input.text.length > NOTICE_CHARS ? `${input.text.slice(0, NOTICE_CHARS)}…` : input.text;
    const notice: Notice = { ...input, text, id, at: Date.now() };
    const replaces = input.key !== undefined && get().notices.some(n => n.key === input.key);
    if (input.key !== undefined) get().end(input.key);
    set(s => {
      const notices = [notice, ...s.notices].slice(0, NOTICE_CAP);
      const keyed = new Set(notices.filter(n => n.key !== undefined).map(n => n.id));
      return { notices, toasts: trimmed([...s.toasts, id], keyed), unread: replaces ? s.unread : s.unread + 1 };
    });
    return id;
  },
  dismiss(id) {
    set(s => (s.toasts.includes(id) ? { toasts: s.toasts.filter(t => t !== id) } : {}));
  },
  end(key) {
    const gone = new Set(get().notices.filter(n => n.key === key).map(n => n.id));
    if (gone.size === 0) return;
    set(s => ({ notices: s.notices.filter(n => !gone.has(n.id)), toasts: s.toasts.filter(t => !gone.has(t)) }));
  },
  clear() {
    set({ notices: [], toasts: [], unread: 0 });
  },
  read() {
    set({ unread: 0 });
  },
}));

export const addNotice = (input: NoticeInput): string => useNotices.getState().add(input);

/** A rejection nothing on screen owns, as a notice of kind error in the host's own words, or those words inside
 * the sentence given. A lost socket says nothing here: the banner already does. */
export function noticeFailure(e: unknown, words: (said: string) => string = said => said, extra: Omit<NoticeInput, "kind" | "text"> = {}): void {
  const failure = failureOf(e);
  if (failure.disconnected) return;
  const said = words(failure.said);
  addNotice({ ...extra, kind: "error", text: failure.fix === undefined ? said : `${said} ${failure.fix}` });
}
