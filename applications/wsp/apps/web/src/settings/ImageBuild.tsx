// SPDX-License-Identifier: AGPL-3.0-only
// The image's own build under the Image card of the computer it runs on, its
// rows framed as one of the card's steps. While the sign-in stage runs the
// sign-ins have the step to themselves, each page
// opening in the person's browser and a code going to the host for that
// tool's terminal. Cancel asks once and is held with its reason while the seal
// runs. A build that ended short stays here with the stage it stopped at, the
// machine still being removed where one is, and Start over; one the provider
// refused the saved key for offers that provider's key field instead.
import { useEffect, useState } from "react";
import { CLOUD_SETUP_WORDS, PROVIDER_KEY_WORDS, initJobBuilding, type InitJob, type PlaceView } from "@wsp/protocol";
import { IMAGE_WORDS } from "./image.js";
import { ProviderKey } from "./ProviderKey.js";
import { SignInSlide, StageList, buildView, type BuildActs } from "./recipe/BuildRows.js";
import { RecipeStep, type StepAction } from "./recipe/RecipeStep.js";
import { useRecipeJob } from "./recipe/useRecipeJob.js";
import { useSettingsStore } from "./settingsStore.js";

export function ImageBuild({ job, place, onAgain, onClose }: { job: InitJob; place: PlaceView; onAgain: () => void; onClose: () => void }) {
  const words = CLOUD_SETUP_WORDS.build;
  const { api, refusal, attempt, busy } = useRecipeJob();
  const [asking, setAsking] = useState(false);
  const [changing, setChanging] = useState(false);
  // Where this build's waits are said: while its rows are drawn here, nowhere else.
  useEffect(() => {
    const settings = useSettingsStore.getState();
    settings.showBuild(place.id);
    return () => settings.hideBuild(place.id);
  }, [place.id]);
  const building = initJobBuilding(job.phase);
  const view = buildView(job);
  const acts: BuildActs = { onRetry: tool => void attempt(() => api!.initRetry!({ tool })), onCode: o => void attempt(() => api!.initSignInCode!(o)) };
  const keyWords = job.keyRefused === true ? PROVIDER_KEY_WORDS[place.id] : undefined;
  const keyHeld = useSettingsStore(s => s.reads.setup?.keys[place.id] === true);
  const stop = (): void => {
    setAsking(false);
    void attempt(() => api!.initCancel!());
  };
  const links: StepAction[] = !building
    ? [{ k: "close", word: IMAGE_WORDS.close, onPress: onClose }]
    : asking
      ? [
          { k: "sure", word: words.cancelSure, destructive: true, confirm: true, onPress: stop },
          { k: "keep", word: words.cancelKeep, onPress: () => setAsking(false) },
        ]
      : [{ k: "cancel", word: words.cancel, destructive: true, disabled: !job.stoppable, onPress: () => setAsking(true) }];
  const primary = building || changing ? undefined : keyWords !== undefined ? { word: CLOUD_SETUP_WORDS.keys.changeKey, onPress: () => setChanging(true) } : { word: words.again, onPress: onAgain };
  const top = building ? (view.slide ? words.slideTop : words.top) : job.error;
  return (
    <RecipeStep
      root="build"
      k={building ? (view.slide ? "slide" : "building") : job.phase}
      headline={view.headline}
      {...(top === undefined ? {} : { top })}
      {...(asking && building ? { note: words.cancelWhy } : {})}
      {...(primary === undefined ? {} : { primary })}
      links={links}
      refusal={refusal}
      {...(building && !job.stoppable ? { waiting: words.cannotStop } : {})}
      busy={busy}
    >
      {view.slide ? <SignInSlide view={view} acts={acts} /> : <StageList job={job} view={view} acts={acts} />}
      {changing && keyWords !== undefined ? (
        <div className="pt-5">
          <ProviderKey
            id={place.id}
            words={keyWords}
            held={keyHeld}
            kept={false}
            onKept={yes => {
              if (!yes) return;
              // The job was about the key just replaced: it is put away, and the recipe is where the next build starts.
              onClose();
              onAgain();
            }}
          />
        </div>
      ) : null}
    </RecipeStep>
  );
}
