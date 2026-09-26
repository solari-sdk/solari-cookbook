// SPDX-License-Identifier: AGPL-3.0-only
// One reading of the image on one computer, folded out of what the host
// already says: the init job for the image's own build, the golden.stage frames
// and the row's build line for a copy's, and copyStanding over the copies for
// what stands. No rule of its own lives here, so the card, the command line and
// the refusals cannot tell a computer's image two ways.
import { COPY_STALE, copyBuildOf, copyStanding, copyStoppedLine, initJobBuilding, type CopyBuild, type GoldenStageEvent, type InitJob, type PlaceView, type SealedImage, type SealedImageCopy, type SealedImageView } from "@wsp/protocol";
import { ClockIcon, HistoryIcon } from "lucide-react";
import type { ChipItem } from "../components/ui/chips.js";
import { builtWhen, copyOn, IMAGE_WORDS, recordChips } from "./image.js";

export type ImageState =
  | { kind: "none" }
  | { kind: "building"; job: InitJob }
  | { kind: "copying"; line: string }
  | { kind: "stopped"; said: string }
  | { kind: "stale"; image: SealedImage; copy: SealedImageCopy }
  | { kind: "ready"; image: SealedImage; copy: SealedImageCopy };

export interface ImageReads {
  view: SealedImageView | null;
  job: InitJob | null;
  /** The store's frames, by the place id each build's frames carry. */
  frames: Readonly<Record<string, readonly GoldenStageEvent[]>>;
}

/** The copy build at this place as its newest frame says, else as the row said when it was read. A sealed frame
 * says nothing: what stands is the copies' to say. Frames are read by id alone, so a computer named after a provider
 * never reads that provider's build. */
function copyBuild(place: PlaceView, frames: ImageReads["frames"]): ImageState | undefined {
  const last = frames[place.id]?.at(-1);
  const build: CopyBuild | undefined = last !== undefined ? copyBuildOf(last) : place.build === undefined ? undefined : { line: place.build, stopped: place.buildStopped === true };
  if (build === undefined) return undefined;
  return build.stopped ? { kind: "stopped", said: build.line } : { kind: "copying", line: build.line };
}

/** What stands on this place, read in order: the image's own build running here, a copy building or stopped here,
 * the copy standing here, then a first build that stopped here. A rebuild that stopped leaves the standing image
 * readable; the job's own rows say why it stopped. Nothing for a place that cannot hold the image at all; where the
 * host has not said whether it can, only what the row and the frames say. */
export function imageState(place: PlaceView, reads: ImageReads): ImageState | undefined {
  if (place.buildsImages === false) return undefined;
  if (place.buildsImages === undefined) return copyBuild(place, reads.frames);
  const { view, job } = reads;
  const jobHere = job !== null && job.place?.id === place.id;
  if (jobHere && initJobBuilding(job.phase)) return { kind: "building", job };
  const building = copyBuild(place, reads.frames);
  if (building !== undefined) return building;
  const image = view?.image ?? null;
  const copy = image === null ? undefined : copyOn(view?.copies ?? [], place);
  if (image !== null && copy !== undefined) return copyStanding(image, copy) === COPY_STALE ? { kind: "stale", image, copy } : { kind: "ready", image, copy };
  if (jobHere && job.phase === "failed") return { kind: "stopped", said: job.error ?? copyStoppedLine() };
  return { kind: "none" };
}

/** The facts a state is drawn with, one chip each: what a standing copy is and when it was built, and how far a stale
 * one is behind. A state with no copy standing has none. */
export function imageChips(state: ImageState, now?: number): ChipItem[] {
  if (state.kind !== "ready" && state.kind !== "stale") return [];
  const built: ChipItem = { text: IMAGE_WORDS.builtChip(builtWhen(state.copy.builtAt, now)), icon: ClockIcon };
  if (state.kind === "stale") return [{ text: IMAGE_WORDS.behindChip(state.image.version), icon: HistoryIcon }, built];
  return [...recordChips(state.image), built];
}
