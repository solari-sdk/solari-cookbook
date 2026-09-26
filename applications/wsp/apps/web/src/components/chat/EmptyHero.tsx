// SPDX-License-Identifier: AGPL-3.0-only
// The mark over a fresh thread's headline: the project's own glyph in its hue, and a soft glow of that hue behind
// the stack.
import { useStore } from "../../protocol/store.js";
import { cn } from "../../lib/utils.js";
import { PROJECT_GLYPHS, PROJECT_HUES } from "../../projects/look.js";

function useLook(projectId: string | undefined) {
  const look = useStore(s => (projectId === undefined ? undefined : s.preferences.projectLook[projectId]));
  const hue = look?.hue ?? "neutral";
  return { Glyph: PROJECT_GLYPHS[look?.icon ?? "folder"], text: hue === "neutral" ? "text-foreground/70" : PROJECT_HUES[hue].text };
}

/** Painted behind the whole stack, never over it. */
export function HeroAtmosphere({ projectId }: { projectId?: string }) {
  const { text } = useLook(projectId);
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", text)}>
      <div className="absolute top-[38%] left-1/2 h-72 w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-[0.07] blur-3xl" />
    </div>
  );
}

/** The project's glyph over the headline. */
export function HeroMark({ projectId }: { projectId?: string }) {
  const { Glyph, text } = useLook(projectId);
  return <Glyph aria-hidden strokeWidth={1.5} className={cn("mx-auto size-10", text)} />;
}
