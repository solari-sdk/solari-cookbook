// SPDX-License-Identifier: AGPL-3.0-only
// The one grammar the sidebar's rows share: the rows' inset and hover, the
// muted mono every machine word wears (a count, a branch, a time, a computer's
// name), the prose ink a state word or a sentence takes, the one-line row and
// the two-line row, the lead slot a mark or a spinner sits in, the tree's child
// list and the rail each of its items draws, and the one id each row wears,
// which the keyboard traversal walks and the name box is opened by.

/** Every row's hover steps its fill and its ink in 150 ms. The kit's own transition is on a row's size, which no
 * row here changes, so it is replaced rather than joined. */
const ROW_FADE_CLASS = "transition-[background-color,color] duration-150";
/** The Forwarded ports head, the one section row left: the rows' inset and the same fade. */
export const TOP_ROW_CLASS = `px-2 ${ROW_FADE_CLASS}`;
const ROW_META_GRAMMAR = "font-mono text-[11px] tabular-nums";
export const ROW_META_CLASS = `${ROW_META_GRAMMAR} text-[var(--top-row-meta)]`;
/** The same grammar for a word a person reads rather than glances at: a state word or a sentence. The counts'
 * whisper sits under AA on purpose; a word that has to be read takes the ink that clears it. */
export const ROW_PROSE_CLASS = `${ROW_META_GRAMMAR} text-[var(--sidebar-prose)]`;
/** A sentence with a period, which is read through rather than glanced at: the sans at the rows' size, in the ink
 * that clears AA. The leaf under a project with no workspace wears it. */
export const ROW_SENTENCE_CLASS = "text-sm text-[var(--sidebar-prose)]";
/** Every row's text: the sans at 13 px, the kit's medium weight kept for the one selected row. A project row, the
 * search row and the head read in the rest ink; a workspace's name and a working thread's title take the sidebar's
 * foreground, since the rest ink on the dark side sits under the muted ink a settled title wears. */
const ROW_TEXT_CLASS = "text-sm font-normal";
/** The one lifted row: the selected fill, and a hairline edge in the token the light side sets to the component
 * tier and the dark side leaves clear, so the lift reads on a light ground where a fill alone does not. */
const LIFTED_ROW_CLASS = "data-[active=true]:inset-ring data-[active=true]:inset-ring-[var(--sidebar-row-edge)]";
const ROW_SHAPE_CLASS = `rounded-[var(--control-radius)] px-2 py-0 text-left ${ROW_TEXT_CLASS} ${ROW_FADE_CLASS} ${LIFTED_ROW_CLASS}`;
/** A one-line row: the search row, the switcher head, a project, a thread, a fold, a leaf, a workspace whose copy
 * carries no branch. 36 px whatever its words. */
export const ONE_LINE_ROW_CLASS = `h-9 gap-2.5 ${ROW_SHAPE_CLASS}`;
/** A two-line row: a workspace on a branch, a creation. 52 px: the first line is a one-line row's height, so the
 * tree's tick lands on it as on every other row, and the second line takes the rest. */
export const TWO_LINE_ROW_CLASS = `h-13 items-start gap-2.5 ${ROW_SHAPE_CLASS}`;
export const TWO_LINE_FIRST_CLASS = "flex h-8 items-center gap-2.5";
export const TWO_LINE_SECOND_CLASS = "flex h-4 items-center leading-4";
export const ROW_LEAD_CLASS = "flex size-4 shrink-0 items-center justify-center";
/** A row whose frame puts glyphs beside it on hover keeps its text running to its own inset: the glyphs land in the
 * slot at the row's right edge, where the word or the count yields to them, rather than taking room off the row. */
export const GLYPH_ROW_CLASS = "group-has-data-[sidebar=menu-action]/menu-item:pe-2";
/** A glyph the hover puts beside a row is nothing at rest at every width. The kit stands it up under its md
 * breakpoint, where a phone's sheet would then show every plus and chevron at once; under that width it is not
 * drawn at all, so a control nobody can see is neither a tap target nor a tab stop. */
export const HOVER_GLYPH_CLASS = "opacity-0 max-md:hidden";
/** The one glyph a width with no pointer keeps at rest, drawn and taking the tap: the selected workspace row's
 * collapse chevron. Worn over the hover glyph's class, which it overrides under the breakpoint. */
export const SELECTED_ROW_GLYPH_CLASS = "max-md:peer-data-[active=true]/menu-button:flex max-md:peer-data-[active=true]/menu-button:opacity-100";

/** A child list of the tree: 12 px in, the rail just inside the parent's lead rather than under its centre; no gap
 * between rows, so the rail segments read as one line. */
export const CHILD_LIST_CLASS = "ml-3 flex min-w-0 flex-col";
/** One item of a child list: the rail down its left edge for its whole height, a tick into its row's first line,
 * and the rail stopping at that tick on the last item, which is the elbow. Its row starts past the elbow, so a
 * lifted or hovered row never paints over it. */
export const RAIL_ITEM_CLASS =
  "relative pl-1 before:absolute before:top-0 before:left-0 before:h-full before:w-px before:bg-[var(--sidebar-rail)] last:before:h-[18px] after:absolute after:top-[18px] after:left-0 after:h-px after:w-1 after:bg-[var(--sidebar-rail)]";

/** The sidebar footer's own row: 36 px, muted, the whole width, the rows' own pitch. Every row in the foot wears it, so the foot
 * reads as one column whether the row is a button or a line with a link at its edge. */
export const FOOT_ROW_GRAMMAR = "flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-muted-foreground";
/** A foot row the whole width of which is pressed, with the same hover and focus every other row wears. The host
 * switcher and the Settings row are both one of these. */
export const FOOT_ROW_CLASS = `${FOOT_ROW_GRAMMAR} transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`;

export const workspaceRowId = (workspaceId: string): string => `ws:${workspaceId}`;
/** A project's row, which the keyboard walks like every other and a test and a screenshot step name it by. */
export const projectRowK = (projectId: string): string => `project:${projectId}`;
export const threadRowId = (threadId: string): string => `thread:${threadId}`;
/** The header over a group of one workspace's thread rows: the idle shelf, and the archive nested inside it. */
export const groupRowId = (group: "settled" | "archived", workspaceId: string): string => `${group}:${workspaceId}`;
