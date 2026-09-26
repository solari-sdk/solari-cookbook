// SPDX-License-Identifier: AGPL-3.0-only
// Choosing what goes on your image, inside the Image card of any computer's
// page: the init job's own steps (the road, the read of this computer, the
// agent's thread, the host's screens with their drafts and disk tally) drawn
// under the card, and Build sending init.build with this computer as the
// place. The recipe is one record, so every computer's card
// edits the same one; once an image stands the host builds it at its own
// place whichever card the press came from, and the last step says so. A typed
// key goes to the key store on Continue and never onto a draft.
import { useEffect, useRef, useState } from "react";
import { CLOUD_SETUP_WORDS, initAgentStep, initJobOver, initStepCounter, type InitSetup, type PlaceView } from "@wsp/protocol";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { copyCost, IMAGE_WORDS } from "./image.js";
import { AgentLine, agentStepWords } from "./recipe/AgentLine.js";
import { ReadingRows } from "./recipe/ReadingRows.js";
import { RecipeScreen } from "./recipe/RecipeScreen.js";
import { RecipeStep, type StepAction } from "./recipe/RecipeStep.js";
import { RoadChoice, roadReady, type RoadPick } from "./recipe/RoadChoice.js";
import { recipeAt, useRecipeJob } from "./recipe/useRecipeJob.js";

export function ImageRecipe({ place, name, version, onClose }: { place: PlaceView; name: string; /** The version the image stands at, absent before the first build. */ version: number | undefined; onClose: () => void }) {
  const select = useStore(s => s.select);
  const recipe = useRecipeJob(place.id);
  const { api, job, refusal, setRefusal, attempt } = recipe;
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const [pick, setPick] = useState<RoadPick>({ road: "manual" });
  // The job an ended agent step was left from for the road again: nothing is cancelled, since the job is over.
  const [againFrom, setAgainFrom] = useState<string | null>(null);
  // The setup priced at this computer: its agents for the road and the first launch's answer, and where a build goes.
  useEffect(() => {
    void api?.initGet?.({ on: place.id }).then(setSetup, e => setRefusal(errorText(e)));
  }, [api, place.id, setRefusal]);
  // Build is with the host while the job may still wait on the place, where no build is drawn yet, so the stop that
  // reaches it is here; a stop sent there leaves the recipe on the road, saying so, and nothing booted.
  const [sending, setSending] = useState(false);
  const stopped = useRef(false);
  const [stoppedHere, setStoppedHere] = useState(false);
  const stop: StepAction = {
    k: "cancel",
    word: CLOUD_SETUP_WORDS.build.cancel,
    destructive: true,
    whileBusy: true,
    onPress: () => {
      stopped.current = true;
      setStoppedHere(true);
      void api?.initCancel?.().catch((e: unknown) => {
        stopped.current = false;
        setStoppedHere(false);
        setRefusal(errorText(e));
      });
    },
  };
  const close: StepAction = { k: "close", word: IMAGE_WORDS.close, onPress: onClose };
  const choose = (): void => {
    setStoppedHere(false);
    recipe.startRoad(pick);
  };
  const again = (): void => {
    setPick({ road: "manual" });
    setAgainFrom(job?.id ?? null);
  };

  if (setup === null) {
    return (
      <RecipeStep k="loading" headline={CLOUD_SETUP_WORDS.choice.headline} top={CLOUD_SETUP_WORDS.choice.top} links={[close]} refusal={refusal} busy={recipe.busy}>
        {null}
      </RecipeStep>
    );
  }
  // A job that ended on the build starts the recipe over from the road; one that ended on the agent's step keeps it.
  if (job === null || (initJobOver(job.phase) && (!initAgentStep(job) || job.id === againFrom))) {
    const words = CLOUD_SETUP_WORDS.choice;
    return (
      <RecipeStep k="choice" headline={words.headline} top={words.top} primary={{ word: words.keycap, onPress: choose, disabled: !roadReady(setup.agents, pick) }} links={[close]} refusal={refusal} {...(stoppedHere ? { waiting: CLOUD_SETUP_WORDS.build.stopped } : {})} busy={recipe.busy}>
        <RoadChoice agents={setup.agents} pick={pick} onPick={setPick} />
      </RecipeStep>
    );
  }
  if (initAgentStep(job)) {
    const words = agentStepWords(job);
    return (
      <RecipeStep
        k="agent"
        headline={words.headline}
        top={words.top}
        {...(words.over ? { primary: { word: CLOUD_SETUP_WORDS.agent.retry, onPress: recipe.retryAgent } } : {})}
        links={words.over ? [{ k: "again", word: CLOUD_SETUP_WORDS.agent.again, onPress: again }, close] : [close]}
        refusal={refusal} busy={recipe.busy}
      >
        <AgentLine
          job={job}
          onOpenThread={() => {
            if (job.thread === undefined) return;
            useStore.getState().closeSettings();
            select(job.thread.workspaceId, job.thread.id);
          }}
        />
      </RecipeStep>
    );
  }
  if (job.phase !== "answering") {
    return (
      <RecipeStep k="reading" headline={CLOUD_SETUP_WORDS.reading.headline} top={CLOUD_SETUP_WORDS.reading.top} links={[close]} refusal={refusal} busy={recipe.busy}>
        <ReadingRows job={job} />
      </RecipeStep>
    );
  }

  const { shown, index, screen } = recipeAt(job);
  const startOver: StepAction = { k: "again", word: CLOUD_SETUP_WORDS.screen.again, onPress: () => recipe.startOver(again) };
  const back: StepAction = { k: "back", word: CLOUD_SETUP_WORDS.screen.back, onPress: () => recipe.stepTo(index - 1) };
  // Where the build goes is the host's word: this computer for a first build, the image's own place after that.
  const home = setup.place;
  const elsewhere = home !== undefined && home.id !== place.id;
  const buildNote = elsewhere ? IMAGE_WORDS.buildsHome(home.name, (version ?? 0) + 1) : undefined;
  const cost = copyCost(setup.pricing?.rateUsdPerHour);
  const build = async (): Promise<void> => {
    stopped.current = false;
    setSending(true);
    try {
      await recipe.build(setup.agents, { on: place.id }, () => stopped.current);
    } catch (e) {
      if (!stopped.current) throw e;
    } finally {
      setSending(false);
    }
  };
  const last = screen !== undefined && index === shown.length - 1;
  if (screen === undefined) {
    return (
      <RecipeStep
        k="ready"
        headline={IMAGE_WORDS.readyHeadline}
        top={IMAGE_WORDS.buildsHere(elsewhere ? home.name : name)}
        {...(buildNote === undefined ? {} : { note: buildNote })}
        cost={cost}
        primary={{ word: IMAGE_WORDS.build, onPress: () => void attempt(build) }}
        links={sending ? [stop, close] : [...(shown.length > 0 ? [{ ...back, onPress: () => recipe.stepTo(shown.length - 1) }] : [startOver]), close]}
        refusal={refusal} busy={recipe.busy}
      >
        {null}
      </RecipeStep>
    );
  }
  const current = recipe.draftAt(screen);
  return (
    <RecipeStep
      key={`${job.id}:${screen.id}`}
      k={`screen-${screen.id}`}
      counter={initStepCounter(index + 1, shown.length)}
      headline={screen.top}
      {...(last && buildNote !== undefined ? { note: buildNote } : {})}
      {...(last ? { cost } : {})}
      primary={last ? { word: IMAGE_WORDS.build, onPress: () => recipe.answer(screen, build) } : { word: CLOUD_SETUP_WORDS.screen.keycap, onPress: () => recipe.answer(screen) }}
      links={sending ? [stop, close] : [index > 0 ? back : startOver, close]}
      refusal={refusal} busy={recipe.busy}
    >
      <RecipeScreen screen={screen} draft={current} onDraft={next => recipe.edit(screen, current, next)} image={recipe.imageAt(screen, current)} />
    </RecipeStep>
  );
}
