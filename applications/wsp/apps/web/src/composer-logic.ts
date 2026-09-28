// Adapted from pingdotgg/t3code apps/web/src/composer-logic.ts at 57a66608 (MIT).
// Differs from upstream: the inline-token cursor maps (expand, collapse,
// clamp, adjacency) and the citation formatter went with the composer's inline
// nodes; detectComposerTrigger keeps the slash arm only, since nothing on the
// wire feeds an @path or $skill menu; parseStandaloneComposerSlashCommand went
// with the built-in plan and default commands. clampComposerCursor is
// upstream's module-local clampCursor, exported.
export type ComposerTriggerKind = "slash-command";
export type ComposerSubmissionIntent = "foreground" | "background";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isDraftThread: boolean;
}): ComposerSubmissionIntent | null {
  if (input.isMobileViewport || input.shiftKey) {
    return null;
  }
  return input.modifierKey && input.isDraftThread ? "background" : "foreground";
}

export function clampComposerCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampComposerCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  return null;
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
