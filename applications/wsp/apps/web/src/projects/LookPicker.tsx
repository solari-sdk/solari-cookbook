// SPDX-License-Identifier: AGPL-3.0-only
// A project's glyph and hue as two selects on its settings page, each drawn with
// what it picks, saved on the pick and drawn at once in the sidebar and the
// switcher.
import { ProjectHue, ProjectIcon } from "@wsp/protocol";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { cn } from "../lib/utils.js";
import { PROJECT_GLYPHS, PROJECT_HUES } from "./look.js";

const word = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

function IconOption({ icon, hue }: { icon: ProjectIcon; hue: ProjectHue }) {
  const Glyph = PROJECT_GLYPHS[icon];
  return (
    <span className="flex items-center gap-2">
      <Glyph aria-hidden className={cn("size-4", PROJECT_HUES[hue].text)} />
      {word(icon)}
    </span>
  );
}

function HueOption({ hue }: { hue: ProjectHue }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn("size-3 rounded-full", PROJECT_HUES[hue].swatch)} />
      {word(hue)}
    </span>
  );
}

export function IconSelect({ icon, hue, onChange, className }: { icon: ProjectIcon; hue: ProjectHue; onChange: (icon: ProjectIcon) => void; className?: string }) {
  return (
    <Select value={icon} onValueChange={next => onChange(ProjectIcon.parse(next))}>
      <SelectTrigger size="sm" aria-label="Icon" data-k="project-icon" className={cn("w-40", className)}>
        <SelectValue>{(value: ProjectIcon) => <IconOption icon={value} hue={hue} />}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {ProjectIcon.options.map(name => (
          <SelectItem key={name} value={name}>
            <IconOption icon={name} hue={hue} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function HueSelect({ hue, onChange, className }: { hue: ProjectHue; onChange: (hue: ProjectHue) => void; className?: string }) {
  return (
    <Select value={hue} onValueChange={next => onChange(ProjectHue.parse(next))}>
      <SelectTrigger size="sm" aria-label="Colour" data-k="project-hue" className={cn("w-40", className)}>
        <SelectValue>{(value: ProjectHue) => <HueOption hue={value} />}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {ProjectHue.options.map(name => (
          <SelectItem key={name} value={name}>
            <HueOption hue={name} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
