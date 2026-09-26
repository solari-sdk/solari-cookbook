// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the new-workspace dialog in either theme
// (?theme=light) with two projects to pick from, the landing of each answered,
// so a test can lay out and photograph the one question, the Project control
// and the line under it. With ?projects=none the dialog has no project to make
// a workspace of, and with ?projects=one the single project reads as a line of
// text instead of a control.
import { createRoot } from "react-dom/client";
import type { Capabilities, PlaceView, ProjectView , WorkspaceLanding } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { NewWorkspaceDialog } from "../../src/sidebar/NewWorkspaceDialog";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const SHARES: Capabilities = {
  liveCloneForks: false,
  replacesMachine: false,
  previewUrls: false,
  signedUrls: false,
  callbackRelay: false,
  diskSnapshots: false,
  images: false,
  snapshotsAnyLife: false,
  snapshotListing: false,
  templates: false,
  sizes: [],
  kept: true,
  copies: true,
  ownNetwork: false,
};
const OWN: Capabilities = { ...SHARES, copies: false, ownNetwork: true, pauseMode: "disk" };

const project = (id: string, name: string, computer: string): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "git", url: `https://github.com/dev/${name}.git` },
  path: `/root/${name}`,
  remote: `https://github.com/dev/${name}.git`,
  defaultBranch: "main",
  memoryKey: `-root-${name}`,
  memoryDir: `/root/.claude-cfg/projects/-root-${name}/memory`,
  createdAt: "2026-09-12T09:31:00.000Z",
});
const here = project("pr_1", "spoo-landing", "here");
const box = project("pr_2", "wsp", "p_1");
const projects = params.get("projects") === "none" ? [] : params.get("projects") === "one" ? [here] : [here, box];
const landings: Record<string, WorkspaceLanding> = {
  pr_1: { name: "here", capabilities: SHARES },
  pr_2: { place: "p_1", name: "spoo", capabilities: OWN },
};
const places = [
  { id: "here", kind: "computer", name: "studio.local", default: false, present: true, takesForks: false },
  { id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true },
] as unknown as PlaceView[];

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <NewWorkspaceDialog projects={projects} landings={landings} places={places} picked={null} onCreate={() => {}} onCancel={() => {}} />
  </TooltipProvider>,
);
