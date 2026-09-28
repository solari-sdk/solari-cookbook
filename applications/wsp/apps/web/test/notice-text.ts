// SPDX-License-Identifier: AGPL-3.0-only
import { useNotices } from "../src/notices/store.js";

/** The newest notice's words, or null while none has been said since the last clear. */
export const lastNotice = (): string | null => useNotices.getState().notices[0]?.text ?? null;
/** Every notice's words, newest first. */
export const noticeTexts = (): string[] => useNotices.getState().notices.map(n => n.text);
export const clearNotices = (): void => useNotices.getState().clear();
/** The newest notice's action word, or null when it carries none. */
export const lastAction = (): string | null => useNotices.getState().notices[0]?.action?.word ?? null;
