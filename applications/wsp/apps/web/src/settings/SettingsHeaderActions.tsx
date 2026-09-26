// SPDX-License-Identifier: AGPL-3.0-only
// The header's right slot while Settings is open: Restore defaults, drawn
// only while a row of the open group is off its default. Its being there is
// the state; it writes the group's one patch. At a phone's width the glyph
// stands alone with its tooltip.
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { usePreferences, useStore } from "../protocol/store.js";
import { SETTINGS_WORDS } from "./format.js";
import { groupById } from "./groups.js";
import { useSettingsAt } from "./settingsContext.js";
import { groupOf } from "./settingsStore.js";

export function SettingsHeaderActions() {
  const at = useSettingsAt();
  const preferences = usePreferences();
  const setPreferences = useStore(s => s.setPreferences);
  const restore = groupById(groupOf(at)).restore;
  if (at.kind !== "group" || restore === undefined || !restore.off(preferences)) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button data-k="restore-defaults" size="xs" variant="ghost-muted" className="[-webkit-app-region:no-drag]" aria-label={SETTINGS_WORDS.restore} onClick={() => void setPreferences(restore.patch)}>
            <RotateCcwIcon />
            <span className="max-sm:hidden">{SETTINGS_WORDS.restore}</span>
          </Button>
        }
      />
      <TooltipPopup side="bottom">{SETTINGS_WORDS.restore}</TooltipPopup>
    </Tooltip>
  );
}
