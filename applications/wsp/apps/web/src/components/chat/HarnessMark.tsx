// SPDX-License-Identifier: AGPL-3.0-only
// The mark of the agent a model or thread belongs to, next to it in the
// composer, on the picker's rail, on the sidebar's thread rows and in the
// agents panel: the mark its catalog module carries, bare, in its own colours
// or its inks where it has them and otherwise in the colour of whatever it sits
// in, like the initials it falls back to.
import { useId, type ComponentProps, type CSSProperties } from "react";
import { agentMark, type AgentMark } from "@wsp/catalog";
import { cn } from "../../lib/utils";

export function harnessInitials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("");
}

const SVG = /^<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>$/;

/** Each ink's theme switch, written out whole so the stylesheet carries it; a mark has at most this many inks. */
const INK_SWITCH = [
  "[--ink-0:var(--ink-0-light)] dark:[--ink-0:var(--ink-0-dark)]",
  "[--ink-1:var(--ink-1-light)] dark:[--ink-1:var(--ink-1-dark)]",
  "[--ink-2:var(--ink-2-light)] dark:[--ink-2:var(--ink-2-dark)]",
] as const;

/** One published svg drawn inline: its viewBox and its shapes, a shape without a fill of its own in the first ink. */
export function MarkSvg({ mark, className, ...rest }: { mark: Pick<AgentMark, "svg" | "inks"> } & Omit<ComponentProps<"svg">, "children" | "dangerouslySetInnerHTML" | "style">) {
  const scope = useId().replace(/[^\w-]/g, "");
  const [, viewBox, body] = SVG.exec(mark.svg.trim()) ?? [];
  if (viewBox === undefined || body === undefined) throw new Error("a mark needs one svg with a viewBox");
  const inks = mark.inks ?? [];
  if (inks.length > INK_SWITCH.length) throw new Error(`a mark has at most ${INK_SWITCH.length} inks`);
  // Ids are per document: a second copy of a gradient paints from the first, and from nothing once the first is hidden.
  const inner = body
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/\bid="([^"]+)"/g, `id="${scope}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${scope}-$1)`);
  const style = inks.length === 0 ? undefined : (Object.fromEntries(inks.flatMap((ink, at) => [[`--ink-${at}-light`, ink.light], [`--ink-${at}-dark`, ink.dark]])) as CSSProperties);
  return (
    <svg
      {...rest}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid"
      className={cn("shrink-0 fill-current", inks.length > 0 && "text-(--ink-0)", inks.map((_, at) => INK_SWITCH[at]), className)}
      style={style}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

export function HarnessMark({ harness, label, className }: { harness: string; label: string; className?: string }) {
  const mark = agentMark(harness);
  if (mark !== undefined) return <MarkSvg mark={mark} className={cn("size-3.5", className)} data-harness-mark={harness} />;
  // Drawn on the box a mark takes, so the letters scale with every size a mark is given and weigh what a mark weighs.
  return (
    <svg viewBox="0 0 20 20" className={cn("size-3.5 shrink-0 fill-current", className)} data-harness-mark={harness} data-initials aria-hidden>
      <text x="10" y="10" textAnchor="middle" dominantBaseline="central" fontSize="14" fontWeight="800" className="font-mono">
        {harnessInitials(label)}
      </text>
    </svg>
  );
}
