// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar footer's door to Settings, in the same 28 px mono row grammar
// the host switcher wears: the gear, the word and the chord at the right edge.
// It stands whatever else the footer holds, so Settings is never reachable
// only by a chord nobody was told about.
import { SettingsIcon } from "lucide-react";
import { useStore } from "../protocol/store.js";
import { cn } from "../lib/utils.js";
import { SETTINGS_WORDS } from "../settings/format.js";
import { FOOT_ROW_CLASS, ROW_META_CLASS } from "./rowGrammar.js";

export function SettingsRow() {
  const openSettings = useStore(s => s.openSettings);
  return (
    <div data-settings-row-foot className="px-1">
      <button type="button" data-k="settings-row" onClick={openSettings} className={FOOT_ROW_CLASS}>
        <SettingsIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{SETTINGS_WORDS.title}</span>
        <span className={cn(ROW_META_CLASS, "shrink-0")}>⌘,</span>
      </button>
    </div>
  );
}
