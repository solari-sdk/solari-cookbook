// SPDX-License-Identifier: AGPL-3.0-only
// A skill's SKILL.md drawn large under its facts: the body with its
// frontmatter taken off, rendered in the markdown renderer's restricted mode,
// since the file is one nobody here wrote and, off skills.sh, one nobody
// installed yet. A file past what a preview carries says how much of it
// shows. The block holds its height while the file is read.
import { SKILL_PREVIEW_BYTES } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { useAppDark } from "../../settings/theme.js";
import ChatMarkdown from "../ChatMarkdown.js";
import { Skeleton } from "../ui/skeleton.js";
import { AGENTS_LIST_WORDS as W, type DocState } from "./agentsRows.js";

/** The body of a SKILL.md: what follows its frontmatter, or the whole file where it has none. */
export function skillBody(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m === null ? text : text.slice(m[0].length);
}

const BOX = "max-h-[480px] min-h-[168px] overflow-y-auto rounded-lg border border-border bg-card px-4 py-3";

export function SkillPreview({ doc }: { doc: DocState }) {
  const dark = useAppDark();
  const preview = doc.preview;
  return (
    <div data-k="skill-preview" className="flex flex-col gap-1.5">
      {preview !== undefined && preview.size > SKILL_PREVIEW_BYTES ? (
        <p data-k="skill-preview-cut" className={FACT}>
          {W.firstOf(SKILL_PREVIEW_BYTES / 1024, Math.ceil(preview.size / 1024))}
        </p>
      ) : null}
      {preview !== undefined ? (
        <div data-k="skill-preview-body" className={BOX}>
          <ChatMarkdown text={skillBody(preview.text)} cwd={undefined} resolvedTheme={dark ? "dark" : "light"} restricted />
        </div>
      ) : doc.error !== undefined ? (
        <RefusalSlot k="skill-preview-refused" said={doc.error} />
      ) : (
        <div aria-busy className={cn(BOX, "flex flex-col gap-2")}>
          {[0, 1, 2].map(n => (
            <Skeleton key={n} className={cn("h-3.5 rounded", n === 2 ? "w-2/3" : "w-full")} />
          ))}
        </div>
      )}
    </div>
  );
}
