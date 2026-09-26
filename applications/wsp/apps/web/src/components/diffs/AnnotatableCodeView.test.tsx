// Adapted from pingdotgg/t3code apps/web/src/components/diffs/AnnotatableCodeView.test.tsx at 57a66608 (MIT).
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  codeViewOptions: null as Record<string, unknown> | null,
}));

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: { options: Record<string, unknown> }) => {
    testState.codeViewOptions = props.options;
    return null;
  },
}));

vi.mock("./DiffCommentAnnotation", () => ({
  DiffCommentAnnotation: () => null,
}));

vi.mock("../files/fileCommentAnnotations", () => ({
  nextFileCommentId: () => "comment-test",
}));

import { AnnotatableCodeView } from "./AnnotatableCodeView";

describe("AnnotatableCodeView", () => {
  beforeEach(() => {
    testState.codeViewOptions = null;
  });

  it("opens comments from Pierre's gutter action without ending line selection", () => {
    renderToStaticMarkup(
      <AnnotatableCodeView
        codeViewKey="test-view"
        files={[]}
        sectionId="working-tree"
        sectionTitle="Working tree"
        reviewComments={[]}
        onAddReviewComment={vi.fn()}
        onRemoveReviewComment={vi.fn()}
        options={{}}
        renderHeaderPrefix={() => null}
      />,
    );

    expect(testState.codeViewOptions).toMatchObject({
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: expect.any(Function),
    });
    expect(testState.codeViewOptions).not.toHaveProperty("onLineSelectionEnd");
  });
});
