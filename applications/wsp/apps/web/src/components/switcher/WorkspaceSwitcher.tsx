// SPDX-License-Identifier: AGPL-3.0-only
// The overlay the switch chord holds up: one card per workspace in sidebar
// order, or in Spaces one per thread of the space on screen in the order they
// were last opened, the highlight walking them while the chord's modifier is
// down. It takes no focus and traps none, since the person is mid-chord and
// the dispatcher owns the keys. Every card is the same box whatever it holds,
// so the highlight moving changes colour and nothing else. The paint waits out
// SWITCHER_PAINT_DELAY_MS while the state does not, so a tap switches without
// ever dimming the app.
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveSidebarProjects } from "../../adapt/index.js";
import { cn } from "../../lib/utils.js";
import { desktopBridge } from "../../lib/desktopShell.js";
import { useStore } from "../../protocol/store.js";
import { ROW_META_CLASS } from "../../sidebar/rowGrammar.js";
import { capturePagePreview, loadPagePreviews, useWorkspacePreviews } from "../../shell/workspacePreviews.js";
import { highlightedTarget, SWITCHER_PAINT_DELAY_MS, targetKey, useWorkspaceSwitcher } from "../../shell/workspaceSwitcher.js";
import { buildSwitcherCards, type SwitcherCard } from "./switcherCards.js";

export function WorkspaceSwitcher() {
  const open = useWorkspaceSwitcher(s => s.open);
  const targets = useWorkspaceSwitcher(s => s.targets);
  const highlighted = useWorkspaceSwitcher(s => {
    const target = highlightedTarget(s);
    return target === null ? null : targetKey(target);
  });
  const from = useWorkspaceSwitcher(s => s.from);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const selectedThreadId = useStore(s => s.selectedThreadId);
  const images = useWorkspacePreviews(s => s.images);
  const [painted, setPainted] = useState(false);

  // The picture is asked for from inside the store update that switches, before React draws the workspace arriving,
  // so what the shell photographs is the one being left. Every switch runs through here, whatever raised it.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const left = previous.selectedId;
        if (left === null || left === state.selectedId) return;
        // A creation row's key is not a workspace; photographing one would spend a slot nothing ever reads.
        if (previous.creations.some(creation => creation.key === left)) return;
        capturePagePreview(left);
      }),
    [],
  );

  useEffect(() => {
    if (open) void loadPagePreviews([...new Set(targets.map(target => target.workspaceId))]);
  }, [open, targets]);

  // The hold, not the step, is what asks for the overlay: a chord let go inside the delay paints nothing. Stepping
  // again does not restart it, so the wait is from the first press however many workspaces a person walks.
  useEffect(() => {
    if (!open) {
      setPainted(false);
      return;
    }
    const timer = setTimeout(() => setPainted(true), SWITCHER_PAINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const cards = useMemo(() => {
    if (!open || !painted) return [];
    return buildSwitcherCards({
      projects: deriveSidebarProjects({ workspaces, statuses, sessions }),
      targets,
      images,
      currentId: from,
      pinnedThreadId: selectedThreadId,
    });
  }, [from, targets, images, open, painted, selectedThreadId, sessions, statuses, workspaces]);

  if (!open || !painted) return null;
  return (
    <div className="dialog-backdrop fixed inset-0 z-[140] flex items-center justify-center">
      <div
        aria-label="Task switcher"
        className="dropdown-glass popover-shadow grid max-h-[70vh] max-w-[calc(100vw-4rem)] grid-cols-[repeat(auto-fit,minmax(14rem,14rem))] gap-2 overflow-y-auto rounded-lg p-2"
        data-workspace-switcher
        role="listbox"
      >
        {cards.map(card => (
          <SwitcherCardView card={card} highlighted={(card.threadId ?? card.workspaceId) === highlighted} key={card.threadId ?? card.workspaceId} />
        ))}
      </div>
    </div>
  );
}

function SwitcherCardView({ card, highlighted }: { card: SwitcherCard; highlighted: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  return (
    <div
      aria-selected={highlighted}
      className={cn("flex w-56 flex-col gap-1 rounded-md p-2 text-left transition-colors duration-150", highlighted && "bg-foreground/[0.09]")}
      data-workspace-card={card.workspaceId}
      data-thread-card={card.threadId ?? undefined}
      ref={ref}
      role="option"
    >
      {card.threadId === null && desktopBridge()?.workspacePreview !== undefined ? <CardPreview card={card} /> : null}
      <span className="truncate text-foreground text-sm" data-card-name>
        {card.name}
      </span>
      <span className={cn(ROW_META_CLASS, "truncate")} data-card-thread>
        {card.threadTitle ?? "No threads yet"}
      </span>
    </div>
  );
}

/** The well keeps its box whether or not a picture has been taken, so a first capture does not move the card.
 * A picture draws its own edge; an empty well is a fill, and a fill cannot hold an edge on a light card, where
 * the muted tint lands two parts in 255 of the white under it. So the empty well wears a hairline instead,
 * which reads on both surfaces, and the ring is drawn inside the box so it moves nothing when the picture lands. */
function CardPreview({ card }: { card: SwitcherCard }) {
  const empty = card.image === null;
  return (
    <div className={cn("mb-1 flex h-[5.5rem] items-center justify-center overflow-hidden rounded-sm bg-muted/40", empty && "ring-1 ring-border ring-inset")} data-card-preview data-card-preview-empty={empty ? "" : undefined}>
      {empty ? <span className="font-mono text-[10px] text-muted-foreground/60">no capture yet</span> : <img alt="" className="h-full w-full object-cover object-top" src={card.image} />}
    </div>
  );
}
