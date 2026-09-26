// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer, on the Computers page itself: the three roads as pictures,
// the way the theme is picked, and the picked road's whole flow in a panel
// under them. Over ssh the host logs in, installs wsp and waits for the box
// to dial back; a cloud is its provider's key, each provider on its own; a
// computer already running wsp types the join line this host mints. Once a
// computer is added the panel goes on to the sign-ins that live on it and to
// its image, the card its own page draws. Every state is read off what the
// host answered.
import { CheckIcon, ChevronRightIcon, CloudIcon, CopyIcon, HashIcon, LaptopIcon, ServerIcon, TerminalIcon, UserIcon, XIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PLACES_WORDS, PLACE_INSTALL, PROVIDER_KEY_WORDS, PlaceAddStep, placeAddSheetWord, placeBuildsNoImageLine, type InitSetup, type PlaceAddJob, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Kbd } from "../components/ui/kbd.js";
import { Spinner } from "../components/ui/spinner.js";
import { MICRO_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { NO_REASON, type Api } from "../protocol/client.js";
import { failureOf, type Failure } from "../protocol/failure.js";
import { addFix, addOverSsh, useAdds, useShownAdd, type SshDraft } from "./adds.js";
import { ADD_COMPUTER_WORDS, FACT } from "./format.js";
import { ComputerRow } from "./computers.js";
import { ComputerSignIns } from "./ComputerSignIns.js";
import { IMAGE_WORDS } from "./image.js";
import { useImageCard, useImageStanding } from "./ImageCard.js";
import { isProviderPlace, placeName } from "./places.js";
import { Card } from "./rows.js";
import { useSettingsContext } from "./settingsContext.js";
import { INPUT, ProviderKey } from "./ProviderKey.js";
import { RefusalSlot } from "./sheetParts.js";

const MINE = ADD_COMPUTER_WORDS;
const PLAN_FACTS: Partial<Record<PlaceAddStep, string>> = { wsp: PLACE_INSTALL.weight };
const KEYCAP = "h-9 px-4 sm:h-9";

type JoinLines = Awaited<ReturnType<NonNullable<Api["mintJoin"]>>>;
type SshHost = Awaited<ReturnType<NonNullable<Api["sshHosts"]>>>[number];
type StepLine = { word: string; state: "waiting" | "running" | "done" | "failed"; fact?: string };

/** Every step of the add as the host kept it. A failed add the host kept no failed step for, refused before its
 * install began, marks the step that was running, or the first step not done. */
function planLines(job: PlaceAddJob | undefined): StepLine[] {
  const steps = job?.steps ?? [];
  const done = (step: PlaceAddStep): boolean => steps.some(s => s.step === step && s.state === "done");
  const failedStep = job?.state === "failed" && !steps.some(s => s.state === "failed") ? (steps.find(s => s.state === "running")?.step ?? PlaceAddStep.options.find(step => !done(step))) : undefined;
  return PlaceAddStep.options.map(step => {
    const kept = steps.find(s => s.step === step);
    const state = step === failedStep ? "failed" : (kept?.state ?? "waiting");
    // A failed step's note is the refusal the slot says whole; the line keeps the step's own words.
    const fact = kept?.state === "failed" ? PLAN_FACTS[step] : (kept?.note ?? PLAN_FACTS[step]);
    return { word: placeAddSheetWord(step, kept?.state === "done" ? "done" : "running"), state, ...(fact === undefined ? {} : { fact }) };
  });
}

function Bar({ w, strong = false }: { w: number; strong?: boolean }) {
  return <span className={cn("block h-1.5 rounded-full", strong ? "bg-foreground/35" : "bg-foreground/15")} style={{ width: `${w}%` }} />;
}

function SshPicture() {
  return (
    <div className="flex h-full items-center justify-center gap-4 p-5">
      <div className="flex w-[52%] flex-col gap-2 rounded-[6px] border border-border bg-background p-3">
        <span className="flex items-center gap-1.5">
          <TerminalIcon aria-hidden className="size-3 text-foreground/50" />
          <Bar w={62} strong />
        </span>
        <Bar w={84} />
        <Bar w={48} />
      </div>
      <div className="flex w-[30%] flex-col gap-1.5">
        {[0, 1, 2].map(at => (
          <span key={at} className="flex items-center gap-1.5 rounded-[4px] border border-border bg-background px-2 py-1.5">
            <span className={cn("size-1.5 rounded-full", at === 0 ? "bg-foreground/50" : "bg-foreground/20")} />
            <Bar w={70} />
          </span>
        ))}
      </div>
    </div>
  );
}

function CloudPicture() {
  return (
    <div className="relative flex h-full items-center justify-center">
      <CloudIcon aria-hidden strokeWidth={1} className="size-24 text-foreground/25" />
      <div className="absolute inset-x-0 top-[48%] flex justify-center gap-1.5">
        {[0, 1, 2].map(at => (
          <span key={at} className="h-4 w-6 rounded-[3px] border border-border bg-background" />
        ))}
      </div>
    </div>
  );
}

function CodePicture() {
  return (
    <div className="flex h-full items-center justify-center gap-3 px-5">
      <LaptopIcon aria-hidden strokeWidth={1.25} className="size-12 text-foreground/40" />
      <div className="flex flex-1 flex-col items-center gap-1.5">
        <span className="rounded-[4px] border border-border bg-background px-2 py-0.5 font-mono text-[10px] tracking-widest text-foreground/60">•••• ••••</span>
        <span className="w-full border-foreground/20 border-t border-dashed" />
      </div>
      <LaptopIcon aria-hidden strokeWidth={1.25} className="size-12 text-foreground/40" />
    </div>
  );
}

function RoadPicker({ value, onChange }: { value: AddRoad | null; onChange: (road: AddRoad) => void }) {
  return (
    <div role="radiogroup" aria-label={MINE.title} className="grid grid-cols-3 gap-4 max-sm:grid-cols-1" data-k="add-roads">
      {(Object.keys(ROADS) as AddRoad[]).map(road => {
        const chosen = road === value;
        return (
          <button key={road} type="button" role="radio" aria-checked={chosen} data-add-road={road} onClick={() => onChange(road)} className="group flex cursor-pointer flex-col gap-2.5 text-left outline-none">
            <span
              className={cn(
                "block aspect-[16/10] w-full overflow-hidden rounded-[10px] border border-border bg-muted/40 ring-offset-2 ring-offset-background transition-shadow duration-150",
                chosen ? "ring-2 ring-primary" : "group-hover:ring-1 group-hover:ring-border",
                "group-focus-visible:ring-2 group-focus-visible:ring-ring",
              )}
            >
              {ROADS[road].picture}
            </span>
            <span className="flex flex-col gap-0.5 px-0.5">
              <span className={cn("text-[13px] transition-colors duration-150", chosen ? "text-foreground" : "text-foreground/80 group-hover:text-foreground")}>{ROADS[road].title}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{ROADS[road].line}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CopyLine({ text, k }: { text: string; k: string }) {
  const [copied, setCopied] = useState<"copied" | "not" | null>(null);
  const copy = (): void => {
    const said = (outcome: "copied" | "not"): void => {
      setCopied(outcome);
      setTimeout(() => setCopied(null), 1500);
    };
    void navigator.clipboard.writeText(text).then(() => said("copied"), () => said("not"));
  };
  const Icon = copied === "copied" ? CheckIcon : copied === "not" ? XIcon : CopyIcon;
  return (
    <div data-k={k} className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 ps-3 pe-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={text}>
        {text}
      </code>
      {copied === "not" ? (
        <span data-k="not-copied" className="shrink-0 font-mono text-[11px] text-destructive-foreground">
          {MINE.notCopied}
        </span>
      ) : null}
      <Button size="icon-xs" variant="ghost" aria-label={copied === "copied" ? MINE.copied : copied === "not" ? MINE.notCopied : MINE.copy} onClick={copy}>
        <Icon className="size-3.5" />
      </Button>
    </div>
  );
}

/** Where an add goes on to: the image on the computer just added, as the card its own page draws, or the one line
 * saying it takes none. Getting here builds nothing; a copy is built on the card's press alone. */
function ImageNext({ place }: { place: PlaceView }) {
  const card = useImageCard(place, useSettingsContext());
  if (place.buildsImages === false) {
    return (
      <p data-k="no-image-here" className="text-[13px] leading-5 text-muted-foreground">
        {placeBuildsNoImageLine(placeName(place))}
      </p>
    );
  }
  return card === undefined ? null : <Card id={card.id} head={card.head} body={card.body} />;
}

function Joined({ place, now, onAgain }: { place: PlaceView; now: number; onAgain: () => void }) {
  return (
    <div className="flex flex-col gap-6" data-k="joined">
      <div className="flex flex-col gap-3">
        <ComputerRow place={place} now={now} />
        <Button size="xs" variant="outline" className="self-start" onClick={onAgain}>
          {MINE.another}
        </Button>
      </div>
      <ComputerSignIns place={place} now={now} />
      <ImageNext place={place} />
    </div>
  );
}


/** One road's flow under the name AddComputer draws over it, the action in the foot. */
function RoadBody({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return (
    <>
      <div className="flex flex-col gap-6">{children}</div>
      {foot === undefined ? null : <footer className="flex items-center gap-3 border-border border-t pt-5">{foot}</footer>}
    </>
  );
}

function Field({ label, icon: Icon, className, children }: { label: string; icon: LucideIcon; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="relative block">
        <Icon aria-hidden className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        {children}
      </span>
    </label>
  );
}

function Steps({ lines }: { lines: readonly StepLine[] }) {
  return (
    <ol data-k="plan" className="flex flex-col gap-2.5">
      {lines.map((line, at) => (
        <li key={line.word} data-state={line.state} className="flex items-center gap-3">
          <span
            {...(line.state === "failed" ? { "data-k": "step-failed" } : {})}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
              line.state === "done" ? "border-foreground/40 bg-foreground/10 text-foreground" : line.state === "running" ? "border-primary text-primary" : line.state === "failed" ? "border-destructive/60 bg-destructive/10 text-destructive" : "border-border text-muted-foreground",
            )}
          >
            {line.state === "done" ? <CheckIcon className="size-3" /> : line.state === "failed" ? <XIcon aria-hidden className="size-3" /> : at + 1}
          </span>
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", line.state === "waiting" ? "text-muted-foreground" : "text-foreground")}>{line.word}</span>
          {line.fact === undefined ? null : <span className="font-mono text-[11px] text-muted-foreground">{line.fact}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The fields as an add typed them: user@host splits at its first @, and a port of 22 is left unsaid. */
function loginOf(job: PlaceAddJob | undefined): SshDraft {
  if (job === undefined) return { user: "", host: "", port: "" };
  const at = job.address.indexOf("@");
  return { user: at === -1 ? "" : job.address.slice(0, at), host: at === -1 ? job.address : job.address.slice(at + 1), port: job.sshPort === undefined ? "" : String(job.sshPort) };
}

function SshRoad({ now }: { now: () => number }) {
  const places = useStore(s => s.places);
  const job = useShownAdd();
  const joined = job?.state === "done" ? places.find(p => p.id === job.placeId) : undefined;
  if (joined !== undefined) {
    return (
      <RoadBody>
        <Joined place={joined} now={now()} onAgain={() => useAdds.setState({ putAway: job!.addId })} />
      </RoadBody>
    );
  }
  return <SshForm job={job?.state === "done" ? undefined : job} />;
}

/** The fields hold a running add's login, else what this window typed and has not sent, else the login of the add
 * shown. Typing writes the draft, which is what clears a refusal: it was about what was asked, not what is typed. */
function SshForm({ job }: { job: PlaceAddJob | undefined }) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const draft = useAdds(s => s.draft);
  const running = job?.state === "running";
  const login = running ? loginOf(job) : (draft ?? loginOf(job));
  const setLogin = (next: SshDraft): void => useAdds.setState({ draft: next });
  const { user, host, port } = login;
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [hostsRefused, setHostsRefused] = useState<Failure | null>(null);
  const placeIds = places.map(p => p.id).join(" ");
  useEffect(() => {
    void api?.sshHosts?.().then(
      found => {
        setHosts(found);
        setHostsRefused(null);
      },
      (e: unknown) => {
        const failure = failureOf(e);
        setHosts([]);
        // A socket that may not ask is not a fault, and a lost one is said by the banner.
        setHostsRefused(failure.kind === "ticket" || failure.disconnected ? null : failure);
      },
    );
  }, [api, placeIds]);
  const add = (asked: { user: string; host: string; port: string }): void => {
    if (asked.host.trim() === "" || api?.addComputerOverSsh === undefined) return;
    const address = asked.user.trim() === "" ? asked.host.trim() : `${asked.user.trim()}@${asked.host.trim()}`;
    const n = Number.parseInt(asked.port, 10);
    addOverSsh(api, { address, ...(Number.isFinite(n) && n !== 22 ? { port: n } : {}) });
  };
  const failed = job?.state === "failed" && draft === null ? job : undefined;
  const fix = failed === undefined ? undefined : addFix(failed);
  const refusal = failed === undefined ? null : { said: failed.said ?? NO_REASON, ...(fix === undefined ? {} : { fix }) };
  const held = api?.addComputerOverSsh === undefined ? MINE.noRoad : undefined;
  const suggested = hosts ?? [];
  const enter = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") add({ user, host, port });
  };
  return (
    <RoadBody
      foot={
        <>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            {running ? MINE.running : <><Kbd>↵</Kbd>{MINE.adds}</>}
          </span>
          <Button data-k="ssh-add" className={cn(KEYCAP, "ms-auto")} held={running || held !== undefined || host.trim() === ""} onClick={() => add({ user, host, port })}>
            {running ? (
              <>
                <Spinner data-k="adding-spinner" aria-hidden role={undefined} className="size-4" />
                {MINE.adding}
              </>
            ) : (
              MINE.addComputer
            )}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,6rem)] gap-3 max-sm:grid-cols-1">
        <Field label={MINE.user} icon={UserIcon}>
          <Input data-k="ssh-user" nativeInput autoComplete="off" spellCheck={false} autoCapitalize="off" disabled={running} value={user} placeholder="root" onChange={e => setLogin({ ...login, user: e.target.value })} onKeyDown={enter} className={INPUT} />
        </Field>
        <Field label={MINE.host} icon={ServerIcon}>
          <Input data-k="login" nativeInput autoFocus autoComplete="off" spellCheck={false} autoCapitalize="off" disabled={running} value={host} placeholder={MINE.hostPlaceholder} {...(refusal === null ? {} : { "aria-invalid": true })} onChange={e => setLogin({ ...login, host: e.target.value })} onKeyDown={enter} className={INPUT} />
        </Field>
        <Field label={MINE.port} icon={HashIcon}>
          <Input data-k="ssh-port" nativeInput inputMode="numeric" autoComplete="off" disabled={running} value={port} placeholder="22" onChange={e => setLogin({ ...login, port: e.target.value.replace(/[^0-9]/g, "") })} onKeyDown={enter} className={INPUT} />
        </Field>
      </div>
      {refusal !== null || held !== undefined ? <RefusalSlot k="ssh-refusal" {...(refusal === null ? { waiting: held } : refusal)} /> : null}
      <div className="flex flex-col gap-3">
        <span className={cn(MICRO_LABEL, "text-muted-foreground")}>{MINE.whatHappens}</span>
        <Steps lines={planLines(job)} />
      </div>
      {!running && hostsRefused !== null ? (
        <RefusalSlot k="ssh-hosts-refused" said={MINE.hostsNotRead(hostsRefused.said)} {...(hostsRefused.fix === undefined ? {} : { fix: hostsRefused.fix })} />
      ) : null}
      {!running && suggested.length > 0 ? (
        <div className="flex flex-col gap-3" data-k="ssh-hosts">
          <span className={cn(MICRO_LABEL, "text-muted-foreground")}>{MINE.suggested}</span>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
            {suggested.slice(0, 8).map(h => (
              <li key={h.alias} className="border-border border-b last:border-b-0">
                <button type="button" data-ssh-host={h.alias} onClick={() => add({ user: h.user ?? "", host: h.alias, port: h.port === undefined ? "" : String(h.port) })} className="group flex h-10 w-full cursor-pointer items-center gap-3 px-3 text-left transition-colors hover:bg-accent/60">
                  <ServerIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  <span className="text-[13px] text-foreground">{h.alias}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{[h.user === undefined ? "" : `${h.user}@`, h.hostName ?? "", h.port === undefined || h.port === 22 ? "" : `:${h.port}`].join("")}</span>
                  <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </RoadBody>
  );
}

/** Under a key the host held before this window: where that cloud's image stands, opening the cloud's page, whose
 * card is the one a key saved here draws under the list. */
function HeldImage({ place }: { place: PlaceView }) {
  const ctx = useSettingsContext();
  const standing = useImageStanding(place, ctx);
  if (standing === undefined) return null;
  return (
    <button type="button" data-k="held-image" className="mt-3 flex items-center gap-2.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:text-foreground/80" onClick={() => ctx.go({ kind: "computer", id: place.id })}>
      <span>{IMAGE_WORDS.head(standing.name)}</span>
      <span className={FACT}>{standing.title}</span>
      <ChevronRightIcon aria-hidden className="ms-auto size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The providers by key, then the image on each cloud whose key this window saved, once the host lists it. */
function CloudRoad({ setup }: { setup: InitSetup | null }) {
  const places = useStore(s => s.places);
  const [kept, setKept] = useState<readonly string[]>([]);
  const onKept = (id: string) => (yes: boolean) => setKept(ids => [...ids.filter(k => k !== id), ...(yes ? [id] : [])]);
  const added = places.filter(p => isProviderPlace(p) && kept.includes(p.id));
  return (
    <RoadBody>
      <div className="flex flex-col divide-y divide-border">
        {Object.entries(PROVIDER_KEY_WORDS).map(([id, words]) => {
          const listed = places.find(p => isProviderPlace(p) && p.id === id);
          return (
            <ProviderKey key={id} id={id} words={words} held={setup?.keys[id] === true} kept={kept.includes(id)} onKept={onKept(id)}>
              {setup?.keys[id] === true && !kept.includes(id) && listed !== undefined ? <HeldImage place={listed} /> : null}
            </ProviderKey>
          );
        })}
      </div>
      {added.map(place => (
        <ImageNext key={place.id} place={place} />
      ))}
    </RoadBody>
  );
}

function CodeRoad({ now }: { now: () => number }) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const [mint, setMint] = useState<JoinLines | null>(null);
  const [refused, setRefused] = useState<Failure | null>(null);
  const before = useRef<ReadonlySet<string> | null>(null);
  const [, tick] = useState(0);
  const again = (): void => {
    setRefused(null);
    setMint(null);
    before.current = new Set(places.map(p => p.id));
    void api?.mintJoin?.().then(setMint, (e: unknown) => setRefused(failureOf(e)));
  };
  useEffect(again, [api]);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const joined = before.current === null ? undefined : places.find(p => !before.current!.has(p.id));
  if (joined !== undefined) {
    return (
      <RoadBody>
        <Joined place={joined} now={now()} onAgain={again} />
      </RoadBody>
    );
  }
  const left = mint === null ? 0 : Math.max(0, Date.parse(mint.expiresAt) - now());
  const expired = mint !== null && left === 0;
  const noMint = api?.mintJoin === undefined;
  return (
    <RoadBody
      foot={
        <>
          <span data-k="code-left" className="font-mono text-[11px] text-muted-foreground">
            {noMint ? MINE.noMint : expired ? MINE.expired : mint === null ? MINE.minting : MINE.codeLeft(left)}
          </span>
          <Button size="xs" variant="outline" className="ms-auto" held={noMint} onClick={again}>
            {MINE.newCode}
          </Button>
        </>
      }
    >
      <Step n={1} word={MINE.installThere}>
        <CopyLine k="install-line" text={PLACES_WORDS.sheet.install} />
      </Step>
      <Step n={2} word={MINE.joinThere}>
        {mint === null ? <div className="h-10 animate-pulse rounded-lg border border-border bg-muted/40" /> : mint.joins.map(j => (
          <div key={j.url} className="flex flex-col gap-1">
            <CopyLine k="join-line" text={j.line} />
            {j.note === undefined ? null : <span className="ps-1 font-mono text-[11px] text-muted-foreground">{j.note}</span>}
          </div>
        ))}
      </Step>
      {refused !== null ? <RefusalSlot k="code-refusal" said={refused.said} {...(refused.fix === undefined ? {} : { fix: refused.fix })} /> : null}
    </RoadBody>
  );
}

function Step({ n, word, children }: { n: number; word: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="flex items-center gap-2.5 text-[13px] text-foreground">
        <span className="inline-flex size-5 items-center justify-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">{n}</span>
        {word}
      </span>
      {children}
    </div>
  );
}

interface Road {
  title: string;
  line: string;
  picture: ReactNode;
  panel: (at: { setup: InitSetup | null; now: () => number }) => ReactNode;
}

/** Every road Add a computer offers, in the order the picker draws them: a new road is one entry here. */
const ROADS = {
  ssh: { title: "Your own server", line: "over ssh", picture: <SshPicture />, panel: ({ now }) => <SshRoad now={now} /> },
  cloud: { title: "A cloud", line: Object.values(PROVIDER_KEY_WORDS).map(p => p.name).join(" or "), picture: <CloudPicture />, panel: ({ setup }) => <CloudRoad setup={setup} /> },
  code: { title: "A computer running wsp", line: "a Mac or PC you sit at", picture: <CodePicture />, panel: ({ now }) => <CodeRoad now={now} /> },
} satisfies Record<string, Road>;
type AddRoad = keyof typeof ROADS;

export function AddComputer({ setup, now = () => Date.now() }: { setup: InitSetup | null; now?: () => number }) {
  const asked = useStore(s => s.addComputerOpen);
  const [road, setRoad] = useState<AddRoad | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!asked) return;
    root.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    setRoad(r => r ?? "ssh");
    useStore.getState().closeAddComputer();
  }, [asked]);
  return (
    <div ref={root} className="flex flex-col gap-12" data-k="add-computer">
      <RoadPicker value={road} onChange={setRoad} />
      {road === null ? null : (
        <section key={road} data-k={`road-${road}`} className="flex flex-col gap-6 motion-safe:animate-[road-in_200ms_ease-out]">
          <header className="text-[15px] font-medium text-foreground">{ROADS[road].title}</header>
          {ROADS[road].panel({ setup, now })}
        </section>
      )}
    </div>
  );
}
