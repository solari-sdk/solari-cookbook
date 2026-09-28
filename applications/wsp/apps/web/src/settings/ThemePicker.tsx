// SPDX-License-Identifier: AGPL-3.0-only
// The theme as a side and a pick on that side: the segments write the side, and
// under them one picture of the app per registered theme of the side shown, each
// drawn by carrying the theme's own mark, so a picture reads its theme's tokens
// and no hex is written twice. System shows the side this computer is on now.
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { PreferencesPatch, ThemePreference } from "@wsp/protocol";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { cn } from "../lib/utils.js";
import { THEMES, type Theme, type ThemeSide } from "../themes/index.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { SETTINGS_WORDS, THEME_WORDS } from "./format.js";
import { SYSTEM_DARK_QUERY, type ThemePicks } from "./theme.js";

const MODES = (["light", "dark", "system"] as const satisfies readonly ThemePreference[]).map(value => ({ value, label: THEME_WORDS[value] }));

const PICK_FIELD = { light: "lightTheme", dark: "darkTheme" } as const satisfies Record<ThemeSide, keyof ThemePicks>;

// One row for either side, as wide as the fuller side, so a flip of the segments never moves the card's height.
const COLUMNS = Math.max(...(["light", "dark"] as const).map(side => THEMES.filter(t => t.side === side).length));

const HAIRLINE = { strokeWidth: 1, vectorEffect: "non-scaling-stroke" } as const;

/** The app drawn small in one theme: a sidebar of bars, a header under a hairline, and a card with its title, two
 * lines of muted text and the primary button. */
function Picture({ theme }: { theme: Theme }) {
  return (
    <svg data-theme={theme.id} viewBox="0 0 160 100" preserveAspectRatio="none" aria-hidden className="block size-full">
      <rect data-part="ground" width="160" height="100" className="fill-background" />
      <rect data-part="sidebar" width="40" height="100" className="fill-sidebar" />
      <line x1="40.5" y1="0" x2="40.5" y2="100" className="stroke-border" {...HAIRLINE} />
      {[22, 16, 19].map((w, at) => (
        <rect key={at} x="8" y={14 + at * 10} width={w} height="4" rx="2" className="fill-sidebar-muted-foreground/60" />
      ))}
      <rect x="50" y="7" width="26" height="4" rx="2" className="fill-muted-foreground/60" />
      <line x1="40" y1="18.5" x2="160" y2="18.5" className="stroke-border" {...HAIRLINE} />
      <rect x="50.5" y="28.5" width="99" height="60" rx="5" className="fill-card stroke-border" {...HAIRLINE} />
      <rect x="59" y="38" width="42" height="4" rx="2" className="fill-foreground" />
      <rect x="59" y="48" width="72" height="4" rx="2" className="fill-muted-foreground/70" />
      <rect x="59" y="56" width="56" height="4" rx="2" className="fill-muted-foreground/70" />
      <rect data-part="keycap" x="115" y="72" width="26" height="9" rx="2.5" className="fill-primary" />
    </svg>
  );
}

export function ThemePicker({ picks, onChange }: { picks: ThemePicks; onChange: (patch: PreferencesPatch) => void }) {
  const systemDark = useMediaQuery(SYSTEM_DARK_QUERY);
  const shown: ThemeSide = picks.theme === "system" ? (systemDark ? "dark" : "light") : picks.theme;
  const field = PICK_FIELD[shown];
  return (
    <div data-k="theme-picker" className="flex flex-col gap-4">
      <SegmentedControl aria-label={SETTINGS_WORDS.theme} value={picks.theme} segments={MODES} onChange={theme => onChange({ theme })} className="self-start" />
      <RadioGroupPrimitive
        aria-label={SETTINGS_WORDS.themesOf(THEME_WORDS[shown])}
        value={picks[field]}
        onValueChange={id => onChange({ [field]: id })}
        className="grid gap-4 max-sm:gap-2"
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
      >
        {THEMES.filter(t => t.side === shown).map(theme => {
          const chosen = theme.id === picks[field];
          return (
            <Tooltip key={theme.id}>
              <TooltipTrigger render={<RadioPrimitive.Root value={theme.id} data-theme-option={theme.id} className="group flex min-w-0 cursor-pointer flex-col items-center gap-2 outline-none" />}>
                <span
                  className={cn(
                    "block aspect-[16/10] w-full overflow-hidden rounded-lg border border-border ring-offset-2 ring-offset-background transition-shadow duration-150",
                    chosen ? "ring-2 ring-primary" : "group-hover:ring-1 group-hover:ring-border",
                    "group-focus-visible:ring-2 group-focus-visible:ring-ring",
                  )}
                >
                  <Picture theme={theme} />
                </span>
                <span className={cn("truncate text-[13px] leading-4 transition-colors duration-150", chosen ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>{theme.word}</span>
              </TooltipTrigger>
              <TooltipPopup sideOffset={6}>{theme.line}</TooltipPopup>
            </Tooltip>
          );
        })}
      </RadioGroupPrimitive>
    </div>
  );
}
