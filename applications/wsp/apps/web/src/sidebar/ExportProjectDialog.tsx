// SPDX-License-Identifier: AGPL-3.0-only
// Exporting a folder from a workspace's machine to this Mac, the reverse of
// the import: one container of quiet sections, the folder on the machine,
// which opens as the thread's own, the folder here, which mirrors it until the
// person edits or picks one, the agents with threads on the workspace as
// ticked rows named as the catalog names them, and what came home, a muted
// word until it did; one action starts the export and the runtime's events
// read in the one slot above the footer. Nothing is read from the machine
// before the destination is checked, so an existing folder comes back as the
// runtime's refusal naming it and its file count, the one loud line, and the
// action becomes Replace and export. The desktop shell gives the folder here
// as a picker row; a browser tab browses this Mac's own folders under the
// path input, and the folder lands inside a browsed one as it would inside a
// picked one.
import { useCallback, useMemo, useRef, useState } from "react";
import { agentName } from "@wsp/catalog";
import { EXPORT_SESSIONS_NOTE, NO_THREADS_NOTE, NOT_LANDED_WORD, exportFromLine, fmtBytes, type ProjectAgentResult, type ProjectExportEvent, type ProjectExportResult, type WorkspaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Spaced } from "../components/ui/spaced.js";
import { useWorkingFolder } from "../files/root.js";
import { desktopBridge } from "../lib/desktopShell.js";
import type { ProtocolEvent } from "../protocol/client.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { agentRows, agentsRequest, exportLandedLine, exportProgress, isExportOf, pickedDest } from "./exportProject.js";
import { FolderBrowser } from "./FolderBrowser.js";
import { useLastFolderParent } from "./lastFolderStore.js";
import { agentOutcome, count, refusalOf, slotWords, type Refusal } from "./projectTrip.js";
import { CachesRow, ConsentRow, FactRow, FolderField, FolderPickerRow, TripSection, TripStatus } from "./ProjectTripRows.js";

type Phase = "idle" | "exporting" | "done";

const DEST_PLACEHOLDER = "/Users/you/code/project";

export function ExportProjectDialog({ workspace, onClose }: { workspace: WorkspaceView; onClose: () => void }) {
  const api = useStore(s => s.api);
  const sessions = useStore(s => s.sessions[workspace.id]);
  const rows = useMemo(() => agentRows(sessions), [sessions]);
  const folder = useWorkingFolder(workspace.id);
  const bridge = desktopBridge()?.pickFolder;
  const lastFolder = useLastFolderParent();
  const [source, setSource] = useState(folder ?? "");
  /** The destination once the person edited or picked it; before that it mirrors the source. */
  const [chosen, setChosen] = useState<string | null>(null);
  const dest = chosen ?? source;
  /** Rows start ticked, so the set holds the ones the person cleared and a row that arrives later starts ticked too. */
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const ticked = useMemo(() => new Set(rows.filter(r => !unticked.has(r))), [rows, unticked]);
  const [events, setEvents] = useState<ProjectExportEvent[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ProjectExportResult | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const sent = useRef({ source: "", dest: "" });

  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if (e.type === "project.export" && isExportOf(e, workspace.id, sent.current.dest)) setEvents(prev => [...prev, e]);
    },
    [workspace.id],
  );
  useProtocolEvents(onEvent);

  const pick = (picked: string): void => {
    setChosen(pickedDest(picked, source));
    setRefusal(null);
  };

  const pickNative = async (): Promise<void> => {
    if (bridge === undefined) return;
    const picked = await bridge();
    if (picked !== undefined) pick(picked);
  };

  const start = async (replace: boolean): Promise<void> => {
    if (api?.exportProject === undefined) return;
    const agents = agentsRequest(rows, ticked);
    sent.current = { source: source.trim(), dest: dest.trim() };
    setPhase("exporting");
    setEvents([]);
    setRefusal(null);
    try {
      const landed = await api.exportProject({ workspaceId: workspace.id, ...sent.current, ...(replace ? { replace: true } : {}), ...(agents !== undefined ? { agents } : {}) });
      setResult(landed);
      setPhase("done");
    } catch (e) {
      setRefusal(refusalOf(e));
      setPhase("idle");
    }
  };

  const toggle = (agent: string, on: boolean): void => {
    setUnticked(prev => {
      const next = new Set(prev);
      if (on) next.delete(agent);
      else next.add(agent);
      return next;
    });
  };

  const busy = phase === "exporting";
  const settled = busy || phase === "done";
  const ready = source.trim() !== "" && dest.trim() !== "";
  const primary = phase === "done" ? "Done" : refusal?.exists ? "Replace and export" : "Export";
  const progress = phase === "idle" ? null : exportProgress(events);
  const said = slotWords({ refusal, landed: result === null ? null : exportLandedLine(result, sent.current.source), progress, idle: "" });
  const outcomeOf = (agent: string): ProjectAgentResult | undefined => result?.agents.find(a => a.agent === agent);

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogPopup className="sm:max-w-xl" showCloseButton={!busy}>
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Export a project</DialogTitle>
            <DialogDescription>{exportFromLine(workspace.name)}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col">
            <TripSection k="source" label="Folder on the task" htmlFor="export-source">
              <FolderField
                id="export-source"
                placeholder="/root/project"
                value={source}
                disabled={settled}
                autoFocus={folder === null}
                onChange={next => {
                  setSource(next);
                  setRefusal(null);
                }}
              />
            </TripSection>
            <TripSection k="dest" label="Folder on this Mac" {...(bridge === undefined ? { htmlFor: "export-dest" } : {})}>
              {bridge === undefined ? (
                <>
                  <FolderField
                    id="export-dest"
                    placeholder={DEST_PLACEHOLDER}
                    value={dest}
                    disabled={settled}
                    onChange={next => {
                      setChosen(next);
                      setRefusal(null);
                    }}
                  />
                  <FolderBrowser disabled={settled} start={lastFolder} onPick={pick} />
                </>
              ) : (
                <FolderPickerRow path={dest} placeholder={DEST_PLACEHOLDER} disabled={settled} onPick={() => void pickNative()} />
              )}
            </TripSection>
            <TripSection k="agents" label="Sessions">
              <Agents rows={rows} ticked={ticked} disabled={phase !== "idle"} outcomeOf={outcomeOf} onToggle={toggle} />
            </TripSection>
            <TripSection k="summary" label="What comes home">
              <div className="flex flex-col">
                <FactRow label="Files" k="files" muted={result === null}>
                  {result === null ? NOT_LANDED_WORD : <Spaced parts={[count(result.files, "file"), fmtBytes(result.bytes)]} />}
                </FactRow>
                <CachesRow excluded={result?.excluded ?? null} idle={NOT_LANDED_WORD} />
              </div>
            </TripSection>
            <TripStatus tone={said.tone} fraction={progress?.fraction ?? null}>
              {said.words}
            </TripStatus>
          </DialogPanel>
          <DialogFooter>
            {phase === "done" ? null : (
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button type="button" disabled={phase !== "done" && (!ready || busy || api?.exportProject === undefined)} onClick={() => (phase === "done" ? onClose() : void start(refusal?.exists === true))}>
              {primary}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function Agents({
  rows,
  ticked,
  disabled,
  outcomeOf,
  onToggle,
}: {
  rows: readonly string[];
  ticked: ReadonlySet<string>;
  disabled: boolean;
  outcomeOf: (agent: string) => ProjectAgentResult | undefined;
  onToggle: (agent: string, on: boolean) => void;
}) {
  return (
    <>
      {rows.length === 0 ? null : (
        <ul className="flex flex-col">
          {rows.map(agent => {
            const landed = outcomeOf(agent);
            return (
              <ConsentRow key={agent} label={agentName(agent)} mono={false} checked={ticked.has(agent)} disabled={disabled} onToggle={next => onToggle(agent, next)}>
                {landed?.sessions === undefined ? null : <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{count(landed.sessions, "session")}</span>}
                <span data-k="outcome" className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground" {...(landed === undefined ? {} : { title: agentOutcome(landed) })}>
                  {landed === undefined ? "" : agentOutcome(landed)}
                </span>
              </ConsentRow>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] leading-4 text-muted-foreground">{rows.length === 0 ? NO_THREADS_NOTE : EXPORT_SESSIONS_NOTE}</p>
    </>
  );
}
