// SPDX-License-Identifier: AGPL-3.0-only
// The mark that leads a row of the setup, from the one place the app's other
// surfaces draw theirs: the agent's own mark from its catalog module, the
// company's bundled glyph for a tool the recipe signs in to. A row whose tool
// has no mark of its own leads with its name; nothing is drawn in a mark's
// place. Never fetched from a favicon service (privacy, offline, one style).
import { agentMark } from "@wsp/catalog";
import { signInMark } from "../../adapt/signins.js";
import { MarkSvg } from "../../components/chat/HarnessMark.js";
import { cn } from "../../lib/utils.js";

/** Whether a row's tool has a mark to lead with, so a card can reserve the column for every row once one does. */
export const hasRowMark = (id: string): boolean => (agentMark(id) ?? signInMark(id)) !== undefined;

export function RowMark({ id, className }: { id: string; className?: string }) {
  const mark = agentMark(id) ?? signInMark(id);
  if (mark === undefined) return null;
  return <MarkSvg mark={mark} className={cn("size-[18px]", className)} data-row-mark={id} />;
}
