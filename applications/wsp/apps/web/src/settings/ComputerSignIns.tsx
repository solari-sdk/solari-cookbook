// SPDX-License-Identifier: AGPL-3.0-only
// The sign-ins that live on a computer just added: each agent on it whose
// login every workspace there shares, with where its sign-in stands and Sign
// in, which runs the agent's own sign-in on that computer through the host
// and draws its page and code under the row. The page opens in this browser
// and a code goes to the tool alone; nothing typed here is kept. Every act is
// held with the away word while the computer is not answering.
import { sharedAgentsOn } from "@wsp/catalog";
import type { AgentsTarget, PlaceView } from "@wsp/protocol";
import { useMemo } from "react";
import { ActButton } from "../components/agents/agentsParts.js";
import { AGENTS_LIST_WORDS, agentSignInStart, holdAll, signInAct, waitingFlow, type RowsContext } from "../components/agents/agentsRows.js";
import { agentRowId, signedIn, signInWord } from "../components/agents/kinds/agents.js";
import { SignInFlowView } from "../components/agents/SignInFlowView.js";
import { useAgentActs } from "../components/agents/useAgentActs.js";
import { useAgentsReport } from "../components/agents/useAgentsReport.js";
import { ADD_COMPUTER_WORDS } from "./format.js";
import { absentOf, placeName } from "./places.js";
import { Card, Row } from "./rows.js";

export function ComputerSignIns({ place, now }: { place: PlaceView; now: number }) {
  const target = useMemo<AgentsTarget>(() => ({ placeId: place.id }), [place.id]);
  const { report } = useAgentsReport(target);
  const acts = useAgentActs(target);
  const name = placeName(place);
  const installed = report?.agents.filter(a => a.installed) ?? [];
  const shared = new Set(sharedAgentsOn(installed.map(a => a.id)));
  const rows = installed.filter(a => shared.has(a.id));
  if (rows.length === 0) return null;
  const ctx: RowsContext = { where: "box", computer: name, heldWhy: absentOf(place, now)?.away ?? null, ...(acts === undefined ? {} : { acts }) };
  return (
    <Card id="sign-ins" head={ADD_COMPUTER_WORDS.signInsOn(name)} lede={ADD_COMPUTER_WORDS.signInsWhy(rows.map(r => r.name), name)}>
      {rows.map(row => {
        const { act, flow } = signInAct(agentRowId(row.id), agentSignInStart(row, ctx), ctx);
        const [held] = holdAll([act], ctx);
        const offered = act.id === "cancel" || !signedIn(row);
        return (
          <div key={row.id} className="flex flex-col">
            <Row
              id={`sign-in-${row.id}`}
              title={row.name}
              description={row.signInRoad === "none" ? "" : AGENTS_LIST_WORDS.roads[row.signInRoad]}
              mono
              word={waitingFlow(flow) ? AGENTS_LIST_WORDS.waitingOnYou : signInWord(row)}
              wordClass="fact"
              drops
              {...(offered ? { control: <ActButton act={held!} /> } : {})}
            />
            {flow === undefined ? null : (
              <div className="px-5 pb-4">
                <SignInFlowView view={flow} label={row.name} />
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}
