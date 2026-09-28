// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Privacy: what this wsp asks of a service outside the person's
// computers, each as one switch.
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { Switch } from "../components/ui/switch.js";
import { PRIVACY_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

export const PRIVACY_DEFAULTS: PreferencesPatch = { serverIcons: DEFAULT_PREFERENCES.serverIcons, agentVersions: DEFAULT_PREFERENCES.agentVersions };

export const privacyOffDefaults = (p: Preferences): boolean => p.serverIcons !== DEFAULT_PREFERENCES.serverIcons || p.agentVersions !== DEFAULT_PREFERENCES.agentVersions;

export function privacyCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  // The host's environment switch outvotes the record, so the row says so rather than offering a switch that asks.
  const envOff = ctx.release?.state === "off";
  return [
    {
      id: "asks",
      items: [
        {
          kind: "row",
          id: "server-icons",
          title: PRIVACY_WORDS.serverIcons,
          description: PRIVACY_WORDS.serverIconsDescription,
          control: <Switch data-k="server-icons" aria-label={PRIVACY_WORDS.serverIcons} checked={preferences.serverIcons} onCheckedChange={serverIcons => setPreferences({ serverIcons })} />,
        },
        {
          kind: "row",
          id: "agent-versions",
          title: PRIVACY_WORDS.agentVersions,
          description: PRIVACY_WORDS.agentVersionsDescription,
          control: (
            <span {...(envOff ? { title: PRIVACY_WORDS.agentVersionsHeld } : {})}>
              <Switch data-k="agent-versions" aria-label={PRIVACY_WORDS.agentVersions} disabled={envOff} checked={!envOff && preferences.agentVersions} onCheckedChange={agentVersions => setPreferences({ agentVersions })} />
            </span>
          ),
        },
      ],
    },
  ];
}
