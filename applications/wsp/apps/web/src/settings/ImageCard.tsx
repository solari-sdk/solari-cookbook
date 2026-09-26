// SPDX-License-Identifier: AGPL-3.0-only
// The Image card on a computer's page, and under Add a computer once that
// computer is added: what stands there of your image, as imageState reads it,
// and the one press that state invites; under it what the image holds, on
// every computer's card alike, with Edit; and the recipe itself, opened in
// place by Build your image here or Edit, or on arrival by an Edit image
// pressed anywhere else in the app; and the image's own build, drawn under the
// card of the computer it runs on until it seals or the person starts over.
// While the recipe or the build is open the state row gives way to it, the
// card's head standing over the step. A copy is built only on Copy, never on
// opening the page, and the time and the rate stand beside the press, since a
// build bills where it runs. While the image builds anywhere, every press that
// would start another build is held with where it is building.
import { PencilIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { HERE_PLACE_ID, copyAsksSignIns, initAgentStep, initJobBuilding, initJobOver, initSignInWaitedOn, signInWaitLine, type PlaceView, type SealedImageView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import type { ChipItem } from "../components/ui/chips.js";
import { Spinner } from "../components/ui/spinner.js";
import { failureOf, type Failure } from "../protocol/failure.js";
import { useGoldenFrames, useStore } from "../protocol/store.js";
import { requestNewWorkspace } from "../shell/shellRequests.js";
import { FACT, WHERE_WORDS } from "./format.js";
import { copyCost, IMAGE_WORDS, recipeNames } from "./image.js";
import { ImageBuild } from "./ImageBuild.js";
import { ImageRecipe } from "./ImageRecipe.js";
import { imageChips, imageState, type ImageState } from "./imageState.js";
import { placeName, projectOn } from "./places.js";
import { RefusalSlot } from "./sheetParts.js";
import { CARD_SURFACE, Row, type SettingsCardData, type SettingsRowData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore } from "./settingsStore.js";
import { cn } from "../lib/utils.js";

/** The Image card under its head for one computer, drawn by the computer's page and by Add a computer once that
 * computer is added: nothing until the host has read the image, and nothing where the computer can hold none. */
export function useImageCard(place: PlaceView, ctx: SettingsContext): SettingsCardData | undefined {
  const standing = useImageStanding(place, ctx);
  if (standing === undefined) return undefined;
  const { name, state, view } = standing;
  return { id: "image", head: IMAGE_WORDS.head(name), items: [], body: <ImageCard place={place} name={name} state={state} view={view} ctx={ctx} /> };
}

/** Where your image stands on one computer, the one reading the card and the line under a held cloud key share. */
export function useImageStanding(place: PlaceView, ctx: SettingsContext): { name: string; state: ImageState; view: SealedImageView; title: string } | undefined {
  const job = useStore(s => s.initJob);
  const frames = useGoldenFrames();
  const view = ctx.reads.image;
  const state = view === null ? undefined : imageState(place, { view, job, frames });
  if (view === null || state === undefined) return undefined;
  return { name: placeName(place, place.id === HERE_PLACE_ID), state, view, title: standingTitle(state, view.image !== null) };
}

/** The title a state stands under: with no image anywhere, nothing here is a copy yet. */
function standingTitle(state: ImageState, imageExists: boolean): string {
  switch (state.kind) {
    case "none":
    case "stopped":
      return imageExists ? IMAGE_WORDS.state.notHere : IMAGE_WORDS.state.nothing;
    case "building":
      return IMAGE_WORDS.state.building;
    case "copying":
      return IMAGE_WORDS.state.copying;
    case "stale":
      return IMAGE_WORDS.state.stale;
    case "ready":
      return IMAGE_WORDS.state.ready;
  }
}

/** The one press a state invites, and why it is held where it is: said under the card, never on a hover. */
type Press = { word: string; heldWhy?: string; run?: () => void };

export function ImageCard({ place, name, state, view, ctx }: { place: PlaceView; name: string; state: ImageState; view: SealedImageView; ctx: SettingsContext }) {
  const [pressing, setPressing] = useState(false);
  const [refused, setRefused] = useState<Failure | null>(null);
  const job = useStore(s => s.initJob);
  const building = job !== null && initJobBuilding(job.phase);
  // A recipe still being chosen stands open on every card that opens, since it is one job whichever card began it;
  // an agent road that ended short stands open on the card it was started from, where its Retry is.
  const [recipeOpen, setRecipeOpen] = useState(() => job !== null && !building && (!initJobOver(job.phase) || (initAgentStep(job) && job.place?.id === place.id)));
  useEffect(() => {
    if (building) setRecipeOpen(false);
  }, [building]);
  const open = recipeOpen && !building;
  // The image's own build at this computer, running or ended short, until Close puts that job away.
  const [putAway, setPutAway] = useState<string | null>(null);
  const buildHere = !open && job !== null && job.place?.id === place.id && !initAgentStep(job) && (building || job.phase === "failed" || job.phase === "cancelled") && putAway !== job.id;
  const buildingAt = building ? ctx.places.find(p => p.id === job.place?.id) : undefined;
  const buildHeld = building ? IMAGE_WORDS.buildingOn(buildingAt === undefined ? (job.place?.name ?? name) : placeName(buildingAt, buildingAt.id === HERE_PLACE_ID)) : ctx.api?.initStart === undefined ? WHERE_WORDS.notYet : undefined;
  const openRecipe = (): void => setRecipeOpen(true);
  const asked = useSettingsStore(s => s.recipeAsked === place.id);
  const heldNow = buildHeld !== undefined;
  useEffect(() => {
    if (!asked) return;
    useSettingsStore.getState().askRecipe(null);
    if (!heldNow) setRecipeOpen(true);
  }, [asked, heldNow]);
  const build = ctx.api?.imageBuild;
  const image = view.image;
  const force = image !== null && copyAsksSignIns(image);
  const copy = (): void => {
    if (build === undefined) return;
    setPressing(true);
    setRefused(null);
    void build(place.id, force || undefined)
      .catch((e: unknown) => setRefused(failureOf(e)))
      .finally(() => setPressing(false));
  };
  const copyPress: Press = { word: force ? IMAGE_WORDS.copyAnyway : IMAGE_WORDS.copyHere, ...(build === undefined ? { heldWhy: WHERE_WORDS.notYet } : { run: copy }) };
  const buildPress: Press = { word: IMAGE_WORDS.buildHere, ...(buildHeld === undefined ? { run: openRecipe } : { heldWhy: buildHeld }) };
  const project = projectOn(place, ctx.projects);
  const cost = copyCost(place.rateUsdPerHour);
  const title = standingTitle(state, image !== null);

  const row = ((): { title: string; description?: string; mono?: boolean; chips?: ChipItem[]; cost?: string[]; note?: string; press?: Press; busy?: boolean } => {
    switch (state.kind) {
      case "none":
        if (image === null) return { title, description: IMAGE_WORDS.chooseAndBuild, press: buildPress };
        return { title, description: force ? IMAGE_WORDS.copyAsks(image.version) : IMAGE_WORDS.copyComes(image.version), cost, press: copyPress };
      case "building": {
        const waitedOn = initSignInWaitedOn(state.job);
        return waitedOn === undefined ? { title, description: IMAGE_WORDS.steps(state.job.progress.done, state.job.progress.total), mono: true, busy: true } : { title, description: signInWaitLine(waitedOn) };
      }
      case "copying":
        return { title, description: state.line, mono: true, busy: true };
      case "stopped":
        // A first build that stopped has no record to copy; building it again opens the recipe.
        return image === null
          ? { title, description: state.said, mono: true, press: buildPress }
          : { title, description: state.said, mono: true, cost, ...(force ? { note: IMAGE_WORDS.copyAsks(image.version) } : {}), press: { ...copyPress, word: force ? IMAGE_WORDS.copyAnyway : IMAGE_WORDS.tryAgain } };
      case "stale":
        return { title, chips: imageChips(state, ctx.now), cost, press: copyPress };
      case "ready":
        return project === undefined
          ? { title, chips: imageChips(state, ctx.now), press: { word: IMAGE_WORDS.startTask, heldWhy: IMAGE_WORDS.startHeld(name) } }
          : {
              title,
              chips: imageChips(state, ctx.now),
              press: {
                word: IMAGE_WORDS.startTask,
                run: () => {
                  useStore.getState().closeSettings();
                  requestNewWorkspace(project.id);
                },
              },
            };
    }
  })();

  // The state row answers what to do now; while the recipe or the build stands under the card that answer is on
  // screen already, so the row goes until Close or the build's end brings it back with the new state.
  const stepOpen = open || buildHere;
  const press = stepOpen ? undefined : row.press;
  const control = row.busy ? (
    <Spinner className="size-4 text-muted-foreground" />
  ) : press === undefined ? undefined : (
    <>
      {row.cost === undefined ? null : (
        <span data-k="image-cost" className={cn(FACT, "flex shrink-0 flex-col items-end whitespace-nowrap leading-4")}>
          {row.cost.map(line => (
            <span key={line}>{line}</span>
          ))}
        </span>
      )}
      <Button data-k="image-press" size="xs" variant="default" held={press.heldWhy !== undefined} disabled={pressing} onClick={press.run}>
        {press.word}
      </Button>
    </>
  );
  const waiting = press?.heldWhy ?? row.note ?? (image !== null && !stepOpen ? buildHeld : undefined);
  const stateRow: Omit<SettingsRowData, "kind"> = {
    id: "image-state",
    title: row.title,
    description: row.description ?? row.chips?.map(chip => chip.text) ?? "",
    mono: row.mono === true,
    ...(row.chips === undefined ? {} : { chips: row.chips }),
    ...(control === undefined ? {} : { control }),
    attrs: { "data-k": "image-state", "data-state": state.kind },
  };
  const holds: Omit<SettingsRowData, "kind"> | undefined =
    image === null
      ? undefined
      : {
          id: "image-holds",
          title: IMAGE_WORDS.holds,
          description: image.recipe === undefined ? IMAGE_WORDS.noRecipe(image.version) : recipeNames(image.recipe),
          ...(open
            ? {}
            : {
                control: (
                  <Button data-k="edit-recipe" size="xs" variant="outline" held={buildHeld !== undefined} onClick={openRecipe}>
                    <PencilIcon aria-hidden className="size-3.5" />
                    {IMAGE_WORDS.holdsEdit}
                  </Button>
                ),
              }),
          attrs: { "data-k": "image-holds" },
        };
  return (
    <div className="flex flex-col gap-3">
      {stepOpen && holds === undefined ? null : (
        <div className={cn(CARD_SURFACE, "flex flex-col divide-y divide-border")}>
          {stepOpen ? null : <Row {...stateRow} drops={row.cost !== undefined && press !== undefined} />}
          {holds === undefined ? null : <Row {...holds} />}
        </div>
      )}
      {open ? (
        <ImageRecipe place={place} name={name} version={image?.version} onClose={() => setRecipeOpen(false)} />
      ) : buildHere && refused === null && waiting === undefined ? null : (
        // The slot stands in every state but one, so a refusal or a held press's reason arriving moves nothing under
        // the card; under a build with nothing to say it gives way to the build.
        <RefusalSlot k="image-refusal" {...(refused === null ? {} : { said: refused.said, ...(refused.fix === undefined ? {} : { fix: refused.fix }) })} {...(waiting === undefined ? {} : { waiting })} />
      )}
      {buildHere ? <ImageBuild key={job.id} job={job} place={place} onAgain={openRecipe} onClose={() => setPutAway(job.id)} /> : null}
    </div>
  );
}
