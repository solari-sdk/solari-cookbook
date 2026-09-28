// SPDX-License-Identifier: AGPL-3.0-only
// New workspace asks one thing: what are you working on. The answer names the
// workspace; it is not the first message, and the composer waits for the ask.
// Everything else is a default: the project is the one there is, or the one
// whose plus was pressed, and the branch, the size and the image are the
// runtime's own business. Enter creates, Escape cancels. The parent keys this
// component per opening so the field resets; a refusal shows on the creation
// view, not here, since the runtime is the one that knows.
//
// Under the pick one line in mono says where the work lands, in the protocol's
// own words, so this dialog holds no second spelling of a computer's name or
// of what a copy's ports are.
import { useState } from "react";
import { portsWord, type PlaceView, type ProjectView , type WorkspaceLanding } from "@wsp/protocol";
import { APP_PLATFORM, PROJECT_PICK_WORDS, landingName } from "../settings/places.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Spaced } from "../components/ui/spaced.js";
import { Select, SelectButton, SelectItem, SelectPopup, SelectValue } from "../components/ui/select.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { cn } from "../lib/utils.js";
import { FACT } from "../settings/format.js";
import { NEW_WORKSPACE, SAY_THE_WORK, WORK_GHOST, WORK_QUESTION } from "./words.js";

/** Beyond this many rows the segmented control is too wide for the dialog, and the same words go in a select. */
const SEGMENT_CAP = 4;

export function NewWorkspaceDialog({
  projects,
  landings,
  places,
  picked,
  onCreate,
  onCancel,
}: {
  /** Every project this wsp holds; the work goes on one of them and the only one is already picked. */
  projects: readonly ProjectView[];
  /** Where a workspace of each project lands, by the project's id, as the host answered; a project it has not
   * answered for yet has no line under the pick rather than a guessed one. */
  landings: Readonly<Record<string, WorkspaceLanding | null>>;
  /** Every computer this wsp holds, so the line under the pick names one the way every other surface names it. */
  places: readonly PlaceView[];
  /** The project whose plus was pressed; with none the first project this host holds is picked. */
  picked: string | null;
  onCreate: (name: string, project: string) => void;
  onCancel: () => void;
}) {
  const [work, setWork] = useState("");
  const [pickedProject, setPickedProject] = useState<string | null>(picked);
  const project = projects.find(p => p.id === pickedProject) ?? projects[0];
  const trimmed = work.trim();
  const held = project === undefined || trimmed.length === 0;
  const landing = project === undefined ? null : landings[project.id] ?? null;
  const submit = (): void => {
    if (held || project === undefined) return;
    onCreate(trimmed, project.id);
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      {/* Anchored at its top, 160 px down, rather than centred: the card is one field and a line, and a dialog that
          stands where the hand left it is one a second opening does not move. */}
      <DialogPopup className="sm:row-start-1 sm:mt-36 sm:max-h-[calc(100dvh-11rem)] sm:max-w-sm sm:self-start">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={e => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{NEW_WORKSPACE}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-workspace-work">{WORK_QUESTION}</Label>
              <Input
                id="new-workspace-work"
                nativeInput
                autoFocus
                autoComplete="off"
                placeholder={WORK_GHOST}
                value={work}
                onChange={e => setWork(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancel();
                  }
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label id="new-workspace-project">{PROJECT_PICK_WORDS.label}</Label>
              {project === undefined ? (
                <p className="text-[13px] text-muted-foreground" data-k="no-project-here">
                  {PROJECT_PICK_WORDS.noneYet}
                </p>
              ) : (
                <>
                  <ProjectPick projects={projects} checked={project} onPick={setPickedProject} />
                  {/* The slot is there from the first paint, so the line arriving moves nothing under it. */}
                  <span className={cn(FACT, "min-h-4")} data-k="landing">
                    {landing === null ? "" : <Spaced parts={landsLine(places, landing)} />}
                  </span>
                </>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" data-k="create" held={held} {...(held ? { title: SAY_THE_WORK } : {})}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Where the work lands: the computer, and what a copy there has for a network, both in the protocol's own words.
 * No road word: which road the next workspace of this project takes is the runtime's own rule, and the row reads
 * it off the record the create answers with. */
export function landsLine(places: readonly PlaceView[], landing: WorkspaceLanding): string[] {
  return [landingName(places, landing), portsWord(landing.capabilities, undefined, APP_PLATFORM)].filter(part => part !== "");
}

/** The projects themselves: the one there is reads as its own name and takes no pick, since a control offering one
 * row asks a question with one answer. Beyond that a segmented control while they fit one line, and the same names
 * in a select beyond that. The checked project is the one the person picked, else the first this host holds. */
function ProjectPick({ projects, checked, onPick }: { projects: readonly ProjectView[]; checked: ProjectView; onPick: (id: string) => void }) {
  if (projects.length === 1) {
    return (
      <p className="text-[13px] text-foreground" data-project={checked.id}>
        {checked.name}
      </p>
    );
  }
  if (projects.length > SEGMENT_CAP) {
    return (
      <Select value={checked.id} onValueChange={value => { if (typeof value === "string") onPick(value); }}>
        <SelectButton size="sm" aria-labelledby="new-workspace-project" className="w-full">
          <SelectValue>{() => checked.name}</SelectValue>
        </SelectButton>
        <SelectPopup>
          {projects.map(project => (
            <SelectItem key={project.id} value={project.id} data-project={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  return (
    <SegmentedControl
      aria-labelledby="new-workspace-project"
      className="self-start"
      value={checked.id}
      segments={projects.map(project => ({ value: project.id, label: project.name }))}
      onChange={onPick}
    />
  );
}
