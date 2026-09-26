// SPDX-License-Identifier: AGPL-3.0-only
// How a report reaches the list: a read the host refuses says the host's own
// sentence with no bars standing for ever, a second visit to a target draws
// the report kept from the first while the new read runs, and a client with
// no such read says so instead of waiting.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentsReport, AgentsTarget } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { forgetAgentsReports, useAgentsReport } from "../src/components/agents/useAgentsReport.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

function Read({ target }: { target: AgentsTarget }) {
  const { report, reading, error } = useAgentsReport(target);
  return <AgentsManager shell="page" head={{ line: "x" }} report={report} reading={reading} error={error} on="spoo" ctx={{ where: "box" }} onRefresh={() => {}} now={Date.parse(AGENTS_REPORT.readAt)} />;
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const refusedLabels = (): string[] => [...document.querySelectorAll("[data-agents-refused] [data-refused-label]")].map(l => l.textContent ?? "");

beforeEach(() => forgetAgentsReports());
afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a report's read", () => {
  it("says the host's own sentence where the read is refused, and stands no bars for ever", async () => {
    useStore.setState({ api: { agentsRead: async () => Promise.reject(new Error("spoo is not answering")) } as unknown as Api });
    render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    expect(refusedLabels()).toEqual(["spoo is not answering"]);
    expect(document.querySelector("[data-k=agents-skeleton]")).toBeNull();
  });

  it("draws the report kept from the last visit while the next read of the same target runs", async () => {
    let answer: (r: AgentsReport) => void = () => {};
    const reads: AgentsTarget[] = [];
    useStore.setState({ api: { agentsRead: async (t: AgentsTarget) => (reads.push(t), reads.length === 1 ? AGENTS_REPORT : new Promise<AgentsReport>(r => (answer = r))) } as unknown as Api });
    const first = render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    first.unmount();
    render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    expect(reads).toHaveLength(2);
    expect(document.querySelectorAll("[data-agents-row]")).toHaveLength(4);
    for (const row of document.querySelectorAll("[data-agents-row]")) expect(row.className).toContain("opacity-50");
    expect(document.querySelector("[data-k=agents-skeleton]")).toBeNull();
    await act(async () => answer({ ...AGENTS_REPORT, agents: [] }));
    expect(document.querySelectorAll("[data-agents-row]")).toHaveLength(0);
  });

  it("says a client with no such read cannot read, rather than standing bars", async () => {
    useStore.setState({ api: {} as unknown as Api });
    render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    expect(document.querySelector("[data-k=agents-skeleton]")).toBeNull();
    expect(refusedLabels()).toEqual([AGENTS_LIST_WORDS.noReader]);
  });
});
