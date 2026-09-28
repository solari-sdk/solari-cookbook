// Adapted from pingdotgg/t3code apps/web/src/components/diffs/DiffCommentAnnotation.test.tsx at 57a66608 (MIT).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DiffCommentAnnotation } from "./DiffCommentAnnotation";

const callbacks = {
  onTextChange: vi.fn(),
  onCancel: vi.fn(),
  onComment: vi.fn(),
  onDelete: vi.fn(),
};

describe("DiffCommentAnnotation", () => {
  it("renders the shared draft composer directly in the selected diff", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation kind="draft" rangeLabel="+78" text="" {...callbacks} />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("Local comment");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("⌘/Ctrl Enter to send");
    expect(markup).toContain("Add a comment…");
    expect(markup).toContain(">Comment</button>");
    expect(markup).toContain("autofocus");
    const textareaControl = markup.match(/<span[^>]*data-slot="textarea-control"[^>]*>/)?.[0];
    expect(textareaControl).toBeDefined();
    expect(textareaControl).not.toContain("ring-ring");
    expect(markup).toContain("cursor-text");
  });

  it("lets a pull-request diff configure actions without replacing the composer", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="src/app.ts:4"
        text=""
        {...callbacks}
        submitLabel="Add to review"
        secondaryAction={{
          label: "Add to agent",
          onAction: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain("Add a comment…");
    expect(markup).toContain(">Add to review</button>");
    expect(markup.match(/<button[^>]*disabled[^>]*>Add to review<\/button>/)).not.toBeNull();
    expect(markup.match(/<button[^>]*disabled[^>]*>Add to agent<\/button>/)).not.toBeNull();
  });

  it("renders a saved comment without a nested card or redundant range label", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Please keep this branch explicit."
        {...callbacks}
      />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("Please keep this branch explicit.");
    expect(markup).toContain('aria-label="Delete comment"');
    // A hairline and the comment's own icon mark the row; a coloured left border two pixels wide is an accent
    // doing what a hairline and an icon already do.
    expect(markup).toContain("border-s border-border");
    expect(markup).not.toContain("border-s-2");
    expect(markup).not.toContain("bg-primary/");
    expect(markup).toContain("lucide-message-circle");
  });

  it("renders draft text owned by the annotation wrapper", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="+78"
        text="Keep this unsaved draft"
        {...callbacks}
      />,
    );

    expect(markup).toContain("Keep this unsaved draft");
  });
});
