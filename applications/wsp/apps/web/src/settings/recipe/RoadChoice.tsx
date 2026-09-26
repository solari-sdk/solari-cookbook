// SPDX-License-Identifier: AGPL-3.0-only
// The recipe's first step: choose what goes on the image on the screens, or
// let an agent on this computer choose from what your agents used. Two rows of
// the card, the app's radio at the left of each, the agent picker in the agent
// row's slot.
import { CLOUD_SETUP_WORDS, type InitAgent, type InitRoad } from "@wsp/protocol";
import { Radio, RadioGroup } from "../../components/ui/radio-group.js";
import { cn } from "../../lib/utils.js";
import { CARD, NAME, ROW, ROW_LINE, RowPicker, STATE_WORD, Slot } from "./rows.js";
import { RowMark } from "./SignInMark.js";

export interface RoadPick {
  road: InitRoad;
  harness?: string;
}

/** The agents the road can start: it hands its thread the wsp tools on the launch, so an agent whose thread cannot
 * take them is shown with its word and never offered, since picking it would open a thread that writes no recipe. */
const usableOf = (agents: readonly InitAgent[]): InitAgent[] => agents.filter(a => a.takesTools);

/** Whether the pick can start: the agent road needs an agent it can hand the tools to. */
export const roadReady = (agents: readonly InitAgent[], pick: RoadPick): boolean => pick.road !== "agent" || usableOf(agents).length > 0;

export function RoadChoice({ agents, pick, onPick }: { agents: readonly InitAgent[]; pick: RoadPick; onPick: (pick: RoadPick) => void }) {
  const words = CLOUD_SETUP_WORDS.choice;
  const usable = usableOf(agents);
  const harness = usable.find(a => a.id === pick.harness)?.id ?? usable[0]?.id;
  const canAgent = usable.length > 0;
  return (
    <RadioGroup aria-label={words.headline} value={pick.road} onValueChange={value => onPick(value === "agent" ? { road: "agent", ...(harness !== undefined ? { harness } : {}) } : { road: "manual" })} className={cn(CARD, "gap-0")}>
      <label className={cn(ROW, ROW_LINE, "cursor-pointer hover:bg-accent/40")}>
        <Radio value="manual" data-k="road-manual" />
        <span className={NAME}>{words.manual}</span>
      </label>
      {/* Under a phone's width the name keeps its line and the picker drops under it, so neither is cut. */}
      <label className={cn(ROW, ROW_LINE, "max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:py-2.5", canAgent ? "cursor-pointer hover:bg-accent/40" : "text-muted-foreground")}>
        <Radio value="agent" data-k="road-agent" disabled={!canAgent} />
        <span className={cn(NAME, "max-sm:whitespace-normal", !canAgent && "text-muted-foreground")}>{words.agent}</span>
        <Slot className="max-sm:basis-full max-sm:justify-start max-sm:pl-7">
          {canAgent ? (
            <>
              {harness !== undefined ? <RowMark id={harness} /> : null}
              <RowPicker k="harness" label={words.agentWith} value={harness} choices={agents.map(a => ({ value: a.id, label: a.name, ...(a.takesTools ? {} : { disabled: true, state: words.noTools }) }))} onPick={value => onPick({ road: "agent", harness: value })} />
            </>
          ) : (
            <span className={STATE_WORD}>{agents.length === 0 ? words.none : words.noTools}</span>
          )}
        </Slot>
      </label>
    </RadioGroup>
  );
}
