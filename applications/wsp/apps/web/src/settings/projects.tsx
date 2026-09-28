// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Projects: one row per project this wsp records, its source and
// the computer it lives on where that is not this one, opening the project's
// own page; and that page, which says the record's facts as lines, what a new
// workspace starts from as rows, and the one act on it. Remove is refused
// while a workspace stands on the project, in the runtime's own sentence,
// and otherwise asks first and lands the runtime's answer as the toast.
import { HueSelect, IconSelect } from "../projects/LookPicker.js";
import { ProjectGlyph } from "../projects/look.js";
import { useState } from "react";
import { agentName } from "@wsp/catalog";
import { HERE_PLACE_ID, fmtBytes, hereWord, plural, projectInUseRefusal, type ProjectLook, type ProjectSource, type ProjectView } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, DANGER_BUTTON, NEUTRAL_RING } from "../components/ui/button.js";
import type { Api } from "../protocol/client.js";
import { placeNames, projectComputerWord } from "../sidebar/workspaceRows.js";
import { PROJECT_WORDS } from "../sidebar/words.js";
import { RefusalSlot } from "./sheetParts.js";
import { PROJECTS_WORDS, WHERE_WORDS } from "./format.js";
import { builtWhen } from "./image.js";
import { isProviderPlace, placeName } from "./places.js";
import { Cards, type SettingsCardData, type SettingsItem } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import type { SettingsAt } from "./settingsStore.js";

/** The word for where a project comes from, by the kind of its source. */
export function sourceWord(source: ProjectSource): string {
  switch (source.kind) {
    case "folder":
      return source.path;
    case "git":
      return source.url;
    case "github":
    case "gitlab":
      return source.repo;
  }
}

/** The workspaces standing on a project, by name, which is what its removal is refused for. */
export const workspacesOn = (ctx: Pick<SettingsContext, "workspaces">, project: Pick<ProjectView, "id">): string[] => ctx.workspaces.filter(w => w.project.id === project.id).map(w => w.name);

/** The one line a remove says by the computer's kind, matching the runtime's three landings. */
export function removeLine(ctx: Pick<SettingsContext, "places">, project: Pick<ProjectView, "computer">): string {
  if (project.computer === HERE_PLACE_ID) return PROJECTS_WORDS.removeHere;
  const place = ctx.places.find(p => p.id === project.computer);
  if (place === undefined) return PROJECTS_WORDS.removeHere;
  return isProviderPlace(place) ? PROJECTS_WORDS.removeAtCloud(placeName(place)) : PROJECTS_WORDS.removeOnComputer(placeName(place));
}

/** The pages under Projects in the sidebar: one per project this wsp records, in the list's own order. */
export function projectSubPages(ctx: SettingsContext): { at: SettingsAt; name: string }[] {
  return ctx.projects.map(project => ({ at: { kind: "project", id: project.id }, name: project.name }));
}

export function projectsCards(ctx: SettingsContext): SettingsCardData[] {
  const named = placeNames(ctx.places);
  const under = (
    <Button size="xs" variant="outline" data-k="add-project-button" onClick={ctx.openAddProject}>
      {PROJECTS_WORDS.add}
    </Button>
  );
  if (ctx.projectsRefused !== null) {
    const { said, fix } = ctx.projectsRefused;
    return [{ id: "projects", items: [], under: <><RefusalSlot k="projects-refused" said={PROJECT_WORDS.notRead(said)} {...(fix === undefined ? {} : { fix })} />{under}</> }];
  }
  if (ctx.projects.length === 0) {
    return [{ id: "projects", items: [{ kind: "row", id: "none", title: PROJECTS_WORDS.none, description: PROJECTS_WORDS.noneDescription, attrs: { "data-k": "projects-none" } }], under }];
  }
  return [
    {
      id: "projects",
      items: ctx.projects.map(project => {
        const here = ctx.places[0];
        const computer = projectComputerWord(project, named) ?? (here === undefined ? hereWord(true) : placeName(here, true));
        const count = workspacesOn(ctx, project).length;
        return {
          kind: "row" as const,
          id: project.id,
          title: project.name,
          lead: <ProjectGlyph projectId={project.id} />,
          description: [computer, sourceWord(project.source)],
          mono: true,
          // A project nothing stands on reads 0: the count is loaded, and a blank where a sibling reads 3 is a
          // fact nobody can tell from a fact that never arrived.
          word: String(count),
          wordClass: "fact" as const,
          open: () => ctx.go({ kind: "project", id: project.id }),
          attrs: { "data-project-row": project.id },
        };
      }),
      under,
    },
  ];
}

/** Remove a project: refused in the runtime's own sentence while a workspace stands on it, else asked once, then
 * the runtime's answer as the toast and the list again. */
function RemoveProjectControl({ project, refusal, line, api, onRemoved, failed, done }: { project: ProjectView; refusal: string | null; line: string; api: Api | null; onRemoved: () => void; failed: (e: unknown) => void; done: (line: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = (): void => {
    if (api?.projectsRemove === undefined) return;
    setBusy(true);
    void api
      .projectsRemove(project.id)
      .then(
        ({ said }) => {
          setAsking(false);
          if (said !== undefined) done(said);
          onRemoved();
        },
        failed,
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Button data-k="remove-project" size="xs" variant="outline" className={DANGER_BUTTON} held={refusal !== null || api?.projectsRemove === undefined} onClick={() => setAsking(true)}>
        {PROJECTS_WORDS.remove}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup data-remove-project-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle data-k="remove-project-title">{PROJECTS_WORDS.removeAsk(project.name)}</AlertDialogTitle>
            <AlertDialogDescription data-k="remove-project-sentence">{line}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{WHERE_WORDS.cancel}</AlertDialogClose>
            <Button data-k="remove-project-confirm" variant="destructive" disabled={busy} onClick={remove}>
              {PROJECTS_WORDS.remove}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** One project's own page. */
export function ProjectPage({ project, ctx }: { project: ProjectView; ctx: SettingsContext }) {
  const place = ctx.places.find(p => p.id === project.computer);
  const computer = project.computer === HERE_PLACE_ID ? hereWord(true) : place === undefined ? project.computer : placeName(place);
  const standing = workspacesOn(ctx, project);
  const refusal = standing.length === 0 ? null : projectInUseRefusal(project.name, standing);
  const line = removeLine(ctx, project);
  const facts: SettingsItem[] = [
    { kind: "line", id: "source", label: PROJECTS_WORDS.source, value: sourceWord(project.source), hover: PROJECTS_WORDS.sourceHover, attrs: { "data-k": "source" } },
    { kind: "line", id: "computer", label: PROJECTS_WORDS.computer, value: computer, hover: PROJECTS_WORDS.computerHover, attrs: { "data-k": "computer" } },
    { kind: "line", id: "remote", label: PROJECTS_WORDS.remote, value: project.remote, hover: PROJECTS_WORDS.remoteHover, attrs: { "data-k": "remote" } },
    { kind: "line", id: "added", label: PROJECTS_WORDS.added, value: builtWhen(project.createdAt, ctx.now), hover: PROJECTS_WORDS.addedHover, attrs: { "data-k": "added" } },
    ...(project.seeded === undefined
      ? []
      : [{ kind: "line" as const, id: "seeded", label: PROJECTS_WORDS.seeded, value: [plural(project.seeded.files, "file"), fmtBytes(project.seeded.bytes), `memory ${project.seeded.memory}`], hover: PROJECTS_WORDS.seededHover, attrs: { "data-k": "seeded" } }]),
  ];
  const starts: SettingsItem[] = [
    { kind: "row", id: "branch", title: PROJECTS_WORDS.branch, description: PROJECTS_WORDS.branchDescription, word: project.base ?? project.defaultBranch, attrs: { "data-k": "branch" } },
    ...(project.lastAgent === undefined ? [] : [{ kind: "row" as const, id: "last-agent", title: PROJECTS_WORDS.lastAgent, description: PROJECTS_WORDS.lastAgentDescription, word: agentName(project.lastAgent), attrs: { "data-k": "last-agent" } }]),
  ];
  const look = ctx.preferences.projectLook[project.id];
  const icon = look?.icon ?? "folder";
  const hue = look?.hue ?? "neutral";
  const setLook = (next: ProjectLook): void => ctx.setPreferences({ projectLook: { [project.id]: next } });
  const cards: SettingsCardData[] = [
    { id: "facts", head: PROJECTS_WORDS.about, items: facts },
    {
      id: "look",
      head: PROJECTS_WORDS.look,
      items: [
        { kind: "row", id: "icon", title: PROJECTS_WORDS.icon, description: PROJECTS_WORDS.iconDescription, control: <IconSelect icon={icon} hue={hue} onChange={next => setLook({ icon: next, hue })} /> },
        { kind: "row", id: "hue", title: PROJECTS_WORDS.hue, description: PROJECTS_WORDS.hueDescription, control: <HueSelect hue={hue} onChange={next => setLook({ icon, hue: next })} /> },
      ],
    },
    { id: "starts", head: PROJECTS_WORDS.newWorkspaces, items: starts },
    {
      id: "acts",
      items: [
        {
          kind: "row",
          id: "remove",
          title: PROJECTS_WORDS.removeTitle(project.name),
          description: refusal ?? line,
          control: <RemoveProjectControl project={project} refusal={refusal} line={line} api={ctx.api} onRemoved={() => void setTimeout(() => ctx.go({ kind: "group", group: "projects" }), 0)} failed={ctx.failed} done={ctx.done} />,
        },
      ],
    },
  ];
  return <Cards cards={cards} />;
}
