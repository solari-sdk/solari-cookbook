// SPDX-License-Identifier: AGPL-3.0-only
// A computer's icon: one of a fixed set, the person's pick where they made
// one, otherwise read off what the computer is. This Mac draws as a laptop
// when its own name says so, a joined box as a server, a cloud account as a
// cloud.
import { BoxIcon, CloudIcon, CpuIcon, HardDriveIcon, HouseIcon, LaptopIcon, MonitorIcon, ServerIcon, type LucideIcon } from "lucide-react";
import { ComputerIcon, HERE_PLACE_ID, type PlaceView } from "@wsp/protocol";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { isProviderPlace } from "./places.js";

export const COMPUTER_GLYPHS: Record<ComputerIcon, LucideIcon> = {
  laptop: LaptopIcon,
  desktop: MonitorIcon,
  server: ServerIcon,
  cloud: CloudIcon,
  cpu: CpuIcon,
  drive: HardDriveIcon,
  container: BoxIcon,
  home: HouseIcon,
};

export function defaultComputerIcon(place: Pick<PlaceView, "id" | "kind" | "label" | "name">): ComputerIcon {
  if (isProviderPlace(place as PlaceView)) return "cloud";
  if (place.id !== HERE_PLACE_ID) return "server";
  return /book|laptop/i.test(place.label ?? place.name) ? "laptop" : "desktop";
}

export function useComputerIcon(place: Pick<PlaceView, "id" | "kind" | "label" | "name">): ComputerIcon {
  return useStore(s => s.preferences.computerLook[place.id]?.icon) ?? defaultComputerIcon(place);
}

export function ComputerGlyph({ place, className }: { place: Pick<PlaceView, "id" | "kind" | "label" | "name">; className?: string }) {
  const Glyph = COMPUTER_GLYPHS[useComputerIcon(place)];
  return <Glyph aria-hidden data-computer-glyph className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

const word = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

function IconOption({ icon }: { icon: ComputerIcon }) {
  const Glyph = COMPUTER_GLYPHS[icon];
  return (
    <span className="flex items-center gap-2">
      <Glyph aria-hidden className="size-4 text-muted-foreground" />
      {word(icon)}
    </span>
  );
}

export function ComputerIconSelect({ place, onChange }: { place: Pick<PlaceView, "id" | "kind" | "label" | "name">; onChange: (icon: ComputerIcon) => void }) {
  const icon = useComputerIcon(place);
  return (
    <Select value={icon} onValueChange={next => onChange(ComputerIcon.parse(next))}>
      <SelectTrigger size="sm" aria-label="Icon" data-k="computer-icon" className="w-40">
        <SelectValue>{(value: ComputerIcon) => <IconOption icon={value} />}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {ComputerIcon.options.map(name => (
          <SelectItem key={name} value={name}>
            <IconOption icon={name} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
