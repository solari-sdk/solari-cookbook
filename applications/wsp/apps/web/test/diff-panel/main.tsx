// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the diff pane's own code view over one
// patch, at the width the right panel gives it in a 1280 px window, in either
// theme (?theme=light). The pane's settings come from diffPanelOptions rather
// than a copy of them here, so what a test measures is what the pane ships.
// The patch is a prose file with a reworded long line, which is what a person
// meets first: a tinted row, a marked word inside it, and a line far wider
// than the panel.
import { createRoot } from "react-dom/client";
import { DiffWorkerPoolProvider } from "../../src/components/DiffWorkerPoolProvider";
import { AnnotatableCodeView } from "../../src/components/diffs/AnnotatableCodeView";
import { diffPanelOptions } from "../../src/diffs/DiffSurface";
import { toDiffModel } from "../../src/diffs/model";
import { PANEL_WIDTH } from "./width";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");

const LONG = "This paragraph is one very long line, far wider than the panel, so the pane has to say somehow that there is more of it to the right than a reader can see at once.";
const PATCH = [
  "diff --git a/README.md b/README.md",
  "index 1111111..2222222 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,4 @@",
  " # livedemo",
  " ",
  "-A folder a live run works in.",
  "+A folder a live run works in, and the sentence a diff has to draw.",
  `+${LONG}`,
  "",
].join("\n");

/** A code file beside the prose one: a changed comment and a changed string are the tokens a grammar paints
 * faintest, and they are the ones a tint can swallow. */
const CODE_PATCH = [
  "diff --git a/src/rate.ts b/src/rate.ts",
  "index 3333333..4444444 100644",
  "--- a/src/rate.ts",
  "+++ b/src/rate.ts",
  "@@ -1,4 +1,4 @@",
  "-// the rate the provider bills while the machine is awake",
  "+// the rate the provider bills for every hour the machine is awake",
  " export const rate = (cpu: number, memMb: number): number =>",
  "-  Number((cpu * 0.02 + (memMb / 1024) * 0.01).toFixed(4));",
  "+  Number((cpu * 0.03 + (memMb / 1024) * 0.02).toFixed(4));",
  "",
].join("\n");

const model = toDiffModel({ base: null, truncated: false, files: [{ path: "README.md", patch: PATCH }, { path: "src/rate.ts", patch: CODE_PATCH }] }, "diff-panel-harness");
const files = model.files.map(f => ({ ...f, collapsed: false }));

createRoot(document.getElementById("root")!).render(
  <DiffWorkerPoolProvider theme={theme}>
    <div className="bg-background" style={{ width: PANEL_WIDTH, height: 560 }} data-diff-panel>
      <AnnotatableCodeView
        codeViewKey="diff-panel-harness"
        files={files}
        sectionId="diff-panel-harness"
        sectionTitle="README.md"
        reviewComments={[]}
        onAddReviewComment={() => {}}
        onRemoveReviewComment={() => {}}
        className="h-full min-h-0 overflow-auto"
        options={diffPanelOptions(theme, "stacked")}
        renderHeaderPrefix={() => null}
      />
    </div>
  </DiffWorkerPoolProvider>,
);
