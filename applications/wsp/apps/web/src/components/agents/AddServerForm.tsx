// SPDX-License-Identifier: AGPL-3.0-only
// Add an MCP server, in place of the list: the agent whose config takes it,
// its name, a command or an address, and the variables or headers it gets,
// each value masked and held by this form alone until the host takes it once
// and writes it into that agent's own file. The file it lands in stands at the
// footer, following the agent and where; the host's refusal stands under it.
import { PlusIcon, XIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { MCP_AGENTS, agentName } from "@wsp/catalog";
import { commandWords, unclosedQuoteRefusal, type AgentsProject, type AgentsReport, type ServerAdd } from "@wsp/protocol";
import { cn, errorText } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Button } from "../ui/button.js";
import { InputGroup, InputGroupInput } from "../ui/input-group.js";
import { SegmentedControl } from "../ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select.js";
import { Spinner } from "../ui/spinner.js";
import { OneOf } from "./agentsParts.js";
import { AGENTS_LIST_WORDS as W, inProject, pickOf, whereNow, type ProjectPick } from "./agentsRows.js";
import type { AddFormProps } from "./kinds/kind.js";

type Road = "command" | "address";

interface Pair {
  readonly id: number;
  readonly name: string;
  readonly value: string;
}

const MONO = "font-mono text-[13px] sm:text-[13px]";

/** The agents there whose config wsp writes servers into, in the catalog's order. */
const serverAgents = (report: AgentsReport | null): string[] => MCP_AGENTS.filter(a => report?.agents.some(r => r.id === a.id && r.installed) === true).map(a => a.id);

/** The file an add for this agent lands in: the one the report already read servers from, else the first the agent
 * reads; a project's own file under that project's folder. */
function fileOf(agent: string, project: AgentsProject | undefined, report: AgentsReport | null): string | undefined {
  const entry = MCP_AGENTS.find(a => a.id === agent);
  if (entry === undefined) return undefined;
  if (project !== undefined) {
    const own = report?.servers.find(r => r.agent === agent && inProject(r, project))?.file;
    const first = entry.mcp.projectFiles?.[0];
    return own ?? (first === undefined ? undefined : `${project.path}/${first}`);
  }
  return report?.servers.find(r => r.agent === agent && r.scope === "user")?.file ?? entry.mcp.files[0];
}

/** One line of the form: its label in the detail's label column and its control. */
function Line({ label, children, top = false }: { label: string; children: ReactNode; top?: boolean }) {
  return (
    <div className={cn("flex min-h-8 gap-3", top ? "items-start" : "items-center")}>
      <span className={cn("flex min-h-8 w-24 shrink-0 items-center text-xs text-muted-foreground @min-[480px]:w-40")}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </div>
  );
}

function Field({ k, value, set, placeholder, label, secret = false, fieldRef, onEnter, className }: { k: string; value: string; set: (v: string) => void; placeholder: string; label: string; secret?: boolean; fieldRef?: RefObject<HTMLElement | null>; onEnter: () => void; className?: string }) {
  return (
    <InputGroup className={cn("h-8", className)}>
      <InputGroupInput
        ref={fieldRef as RefObject<HTMLInputElement | null> | undefined}
        data-k={k}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        {...(secret ? { type: "password" } : {})}
        className={MONO}
        onChange={e => set(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          onEnter();
        }}
      />
    </InputGroup>
  );
}

export function AddServerForm({ report, ctx, first, done }: AddFormProps) {
  const agents = serverAgents(report);
  const [agent, setAgent] = useState<string>(agents[0] ?? "");
  const [name, setName] = useState("");
  const [road, setRoad] = useState<Road>("command");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [pairs, setPairs] = useState<readonly Pair[]>([]);
  const [next, setNext] = useState(0);
  const [picked, setPicked] = useState<ProjectPick | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const servers = ctx.servers;
  const on = ctx.on ?? ctx.computer ?? "";

  if (agents.length === 0 || servers === undefined) {
    return (
      <p data-k="add-server-none" className="flex min-h-[168px] items-center justify-center text-center text-[13px] text-muted-foreground">
        {W.noServerAgents(on)}
      </p>
    );
  }

  const named = pairs.filter(p => p.name.trim() !== "" || p.value !== "");
  const where = whereNow(report, picked, on);
  const project = where.project;
  const ready = where.lost === undefined && agent !== "" && name.trim() !== "" && (road === "command" ? command.trim() !== "" : url.trim() !== "") && named.every(p => p.name.trim() !== "") && !adding;
  const file = where.lost === undefined ? fileOf(agent, project, report) : undefined;

  const submit = (): void => {
    if (!ready) return;
    const words = road === "command" ? commandWords(command) : [];
    if (words === undefined) return setRefused(unclosedQuoteRefusal);
    if (new Set(named.map(p => p.name.trim())).size < named.length) return setRefused(W.twoPairsOneName(road));
    const values = Object.fromEntries(named.map(p => [p.name.trim(), p.value]));
    const [program = "", ...args] = words;
    const ask: ServerAdd = {
      agent,
      name: name.trim(),
      ...(project === undefined ? {} : { project: true }),
      ...(road === "command" ? { command: program, args, ...(named.length > 0 ? { env: values } : {}) } : { url: url.trim(), ...(named.length > 0 ? { headers: values } : {}) }),
    };
    setAdding(true);
    setRefused(undefined);
    servers.add(ask, project).then(done, (e: unknown) => {
      setAdding(false);
      setRefused(errorText(e));
    });
  };

  const pick = (to: Road): void => {
    // Variables and headers are not the same thing, so a switch of road starts them over.
    if (to !== road) setPairs([]);
    setRoad(to);
  };
  const setPair = (id: number, change: Partial<Pair>): void => setPairs(all => all.map(p => (p.id === id ? { ...p, ...change } : p)));
  const addPair = (): void => {
    setPairs(all => [...all, { id: next, name: "", value: "" }]);
    setNext(n => n + 1);
  };

  return (
    <div data-add-server className="flex flex-col gap-3">
      <Line label={W.agent}>
        <Select value={agent} onValueChange={v => typeof v === "string" && setAgent(v)}>
          <SelectTrigger size="default" aria-label={W.agent} data-k="add-server-agent" className="h-8 min-h-8 w-full">
            <SelectValue>
              {(value: string) => (
                <span className="flex items-center gap-2">
                  <HarnessMark harness={value} label={agentName(value)} className="size-3.5" />
                  {agentName(value)}
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {agents.map(id => (
              <SelectItem key={id} value={id} data-k={`add-server-agent-${id}`}>
                <span className="flex items-center gap-2">
                  <HarnessMark harness={id} label={agentName(id)} className="size-3.5" />
                  {agentName(id)}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Line>
      <Line label={W.serverName}>
        <Field k="add-server-name" value={name} set={setName} placeholder="notion" label={W.serverName} fieldRef={first} onEnter={submit} />
      </Line>
      <Line label={W.reachedBy}>
        <SegmentedControl
          value={road}
          onChange={pick}
          className="h-7 self-start"
          segmentClassName="px-2.5 text-xs"
          segments={[
            { value: "command", label: W.byCommand },
            { value: "address", label: W.byAddress },
          ]}
        />
      </Line>
      {road === "command" ? (
        <Line label={W.command}>
          <Field k="add-server-command" value={command} set={setCommand} placeholder="npx -y @notionhq/notion-mcp-server" label={W.command} onEnter={submit} />
        </Line>
      ) : (
        <Line label={W.url}>
          <Field k="add-server-url" value={url} set={setUrl} placeholder="https://mcp.notion.com/mcp" label={W.url} onEnter={submit} />
        </Line>
      )}
      <Line label={road === "command" ? W.variables : W.headers} top>
        {pairs.map(p => (
          // Under 480 the name stands whole over its value, since two halves of the panel cut a header's name.
          <div key={p.id} data-server-pair className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @min-[480px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Field k="add-server-pair-name" className="col-span-2 @min-[480px]:col-span-1" value={p.name} set={v => setPair(p.id, { name: v })} placeholder={road === "command" ? "API_KEY" : "Authorization"} label={road === "command" ? W.variables : W.headers} onEnter={submit} />
            <Field k="add-server-pair-value" value={p.value} set={v => setPair(p.id, { value: v })} placeholder={W.value} label={`${W.value} of ${p.name.trim() === "" ? (road === "command" ? "the variable" : "the header") : p.name.trim()}`} secret onEnter={submit} />
            <Button data-k="add-server-pair-drop" size="icon-xs" variant="ghost" aria-label={W.removePair(p.name.trim())} onClick={() => setPairs(all => all.filter(x => x.id !== p.id))}>
              <XIcon />
            </Button>
          </div>
        ))}
        <Button data-k="add-server-pair-add" size="xs" variant="ghost-muted" className="self-start" onClick={addPair}>
          <PlusIcon aria-hidden className="size-3.5" />
          {road === "command" ? W.addVariable : W.addHeader}
        </Button>
      </Line>
      {where.options.length === 0 ? null : (
        <Line label={W.where} top>
          <OneOf k="where-pick" label={W.where} options={where.options} value={where.value} set={v => setPicked(pickOf(report, v))} {...(where.lost === undefined ? {} : { lost: where.lost })} />
        </Line>
      )}
      <div data-add-server-footer className="mt-1 flex items-center gap-3 border-t border-border pt-4">
        <span data-k="add-server-file" className={cn(FACT, "min-w-0 truncate")} title={file}>
          {file}
        </span>
        <Button data-k="add-server-go" size="default" className="ml-auto shrink-0" held={!ready} {...(ready ? { onClick: submit } : {})}>
          {adding ? <Spinner className="size-4" /> : <PlusIcon aria-hidden className="size-4" />}
          {adding ? W.adding : W.addServerGo}
        </Button>
      </div>
      <RefusalSlot k="add-server-refused" {...(refused === undefined ? {} : { said: refused })} />
    </div>
  );
}
