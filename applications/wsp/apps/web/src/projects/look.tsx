// SPDX-License-Identifier: AGPL-3.0-only
// How a project is drawn wherever it is named: the glyph and hue the person
// picked on its settings page, kept in the host's preferences record, over the
// folder in the row's own ink where nothing was picked.
import {
  BookIcon,
  BoxIcon,
  CameraIcon,
  CodeIcon,
  CpuIcon,
  DatabaseIcon,
  FlameIcon,
  FolderIcon,
  Gamepad2Icon,
  GlobeIcon,
  HeartIcon,
  LeafIcon,
  MusicIcon,
  RocketIcon,
  ServerIcon,
  ShieldIcon,
  StarIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { ProjectHue, ProjectIcon } from "@wsp/protocol";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";

export const PROJECT_GLYPHS: Record<ProjectIcon, LucideIcon> = {
  folder: FolderIcon,
  code: CodeIcon,
  terminal: TerminalIcon,
  globe: GlobeIcon,
  rocket: RocketIcon,
  box: BoxIcon,
  database: DatabaseIcon,
  server: ServerIcon,
  cpu: CpuIcon,
  zap: ZapIcon,
  flame: FlameIcon,
  leaf: LeafIcon,
  star: StarIcon,
  heart: HeartIcon,
  book: BookIcon,
  music: MusicIcon,
  camera: CameraIcon,
  gamepad: Gamepad2Icon,
  shield: ShieldIcon,
  wrench: WrenchIcon,
};

/** Each hue as text and as a swatch; neutral is the row's own ink, so a project nobody coloured reads as before. */
export const PROJECT_HUES: Record<ProjectHue, { text: string; swatch: string }> = {
  neutral: { text: "", swatch: "bg-muted-foreground" },
  red: { text: "text-red-500", swatch: "bg-red-500" },
  orange: { text: "text-orange-500", swatch: "bg-orange-500" },
  amber: { text: "text-amber-500", swatch: "bg-amber-500" },
  green: { text: "text-emerald-500", swatch: "bg-emerald-500" },
  teal: { text: "text-teal-500", swatch: "bg-teal-500" },
  blue: { text: "text-sky-500", swatch: "bg-sky-500" },
  violet: { text: "text-violet-500", swatch: "bg-violet-500" },
  pink: { text: "text-pink-500", swatch: "bg-pink-500" },
};

export function ProjectGlyph({ projectId, className }: { projectId: string; className?: string }) {
  const look = useStore(s => s.preferences.projectLook[projectId]);
  const Glyph = PROJECT_GLYPHS[look?.icon ?? "folder"];
  const hue = look?.hue ?? "neutral";
  // A hue the person picked is the glyph's own; the row's hover and selected inks leave it alone.
  return <Glyph aria-hidden data-hue={hue === "neutral" ? undefined : hue} className={cn("size-4 shrink-0", PROJECT_HUES[hue].text, className)} />;
}
