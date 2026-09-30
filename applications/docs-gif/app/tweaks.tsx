import { useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { ChevronRight, Loader2, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Tweaks } from "../pipeline/serve";

// Fetched once before the app renders, then a tiny store. setTweaks re-renders
// every useTweaks() caller at once. Nothing reaches the server until Done.
let tweaks: Tweaks = await (await fetch("/api/tweaks")).json();
let saved = tweaks;
// Which row of the panel is open, so the toolbar can ring that chip. Local only.
let open: keyof Tweaks | null = null;
let moving: Promise<void> | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((cb) => cb());
const subscribe = (cb: () => void) => (subs.add(cb), () => void subs.delete(cb));
export const useTweaks = () => useSyncExternalStore(subscribe, () => tweaks);
export const useOpenTweak = () => useSyncExternalStore(subscribe, () => open);
export function setTweaks(patch: Partial<Tweaks>) {
  tweaks = { ...tweaks, ...patch };
  // The chip slides to its new slot: the browser snapshots before and after the
  // synchronous re-render and animates each view-transition-name between them.
  // While it runs, the page is covered by the transition overlay and clicks land
  // on it, so the popover treats a click on a tile as "outside": see moving.
  if (document.startViewTransition)
    moving = document.startViewTransition(() => flushSync(notify)).finished.finally(() => (moving = null));
  else notify();
}
export const useDirty = () => useSyncExternalStore(subscribe, () => tweaks !== saved);

// The pipeline's step names ("→ record"), mapped to what the person is waiting on.
const STAGES: [RegExp, string][] = [
  [/^update: /, "Starting a sandbox"],
  [/^app on /, "Opening the browser"],
  [/^→ plan goals/, "Reading the docs"],
  [/^→ record/, "Recording new GIFs"],
  [/^→ verify/, "Checking the GIFs"],
  [/^→ retry failed/, "Retrying the failed ones"],
  [/^→ write docs/, "Updating the docs"],
];
type Status = { kind: "idle" | "busy" | "done" | "error"; text: string };
// One POST saves the tweaks and runs the update pipeline; reports each stage as it starts.
// The server ends the stream with "exit <code>", which tells a finished run from a crash.
async function updateDocs(report: (s: Status) => void) {
  report({ kind: "busy", text: "Saving the layout" });
  const res = await fetch("/api/tweaks", { method: "POST", body: JSON.stringify(tweaks) });
  if (!res.ok) return report({ kind: "error", text: await res.text() });
  saved = tweaks;
  notify();
  let page = "";
  let error = "";
  let none = false; // the pipeline found no changed doc, so nothing was recorded
  let rest = ""; // a chunk can end mid-line
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    const lines = (rest + r.value).split("\n");
    rest = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("# ")) page = line.slice(2).split("/").pop()!.replace(".md", "");
      const stage = STAGES.find(([re]) => re.test(line))?.[1];
      if (stage) report({ kind: "busy", text: page ? `${stage}: ${page}` : stage });
      // The first "SomeError: ..." line of a crash, trimmed to its message when it carries one.
      if (!error && /^\s*(error:|\w*Error\b)/.test(line)) error = line.match(/"message":"([^"]+)"/)?.[1] ?? line.trim();
      if (line.startsWith("nothing changed")) none = true;
      if (line === "exit 0") report(none ? { kind: "idle", text: "No doc describes that spot, so nothing was re-recorded" } : { kind: "done", text: page });
      else if (line.startsWith("exit ")) report({ kind: "error", text: error || `pipeline exited with ${line.slice(5)}` });
    }
  }
}

export function setOpenTweak(key: keyof Tweaks | null) {
  open = key;
  notify();
  document.querySelector(`[data-tweak="${key}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

type Pos = Tweaks["status"];
const POS: Pos[] = ["left", "middle", "right"];

// Three little slots, the chosen one filled: the toolbar in miniature.
const Slots = ({ pos }: { pos: Pos }) => (
  <span className="flex gap-1">
    {POS.map((p) => (
      <span key={p} className={`h-3 w-5 rounded-[3px] ${p === pos ? "bg-current" : "bg-current/25"}`} />
    ))}
  </span>
);

const ROWS: { key: keyof Tweaks; title: string }[] = [
  { key: "status", title: "Status filter" },
  { key: "add", title: "Add Task button" },
];

export function TweaksPanel() {
  const tweaks = useTweaks();
  const dirty = useDirty();
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const [error, setError] = useState("");
  return (
    <Popover onOpenChange={(o) => !o && setOpenTweak(null)}>
      <PopoverTrigger asChild>
        <Button
          size="lg"
          className="fixed right-6 bottom-6 bg-blue-600 text-white shadow-lg shadow-blue-600/40 hover:bg-blue-700 data-[state=open]:bg-blue-700"
        >
          <SlidersHorizontal />
          Tweak the UI
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-96 p-0 text-sm"
        onInteractOutside={(e) => moving && e.preventDefault()}
      >
        {ROWS.map((r) => (
          // name= makes the rows exclusive: opening one closes the others.
          <details
            key={r.key}
            name="tweak"
            className="group border-b last:border-b-0"
            // Rows are exclusive, so a row's close event can land after the next row's open.
            onToggle={(e) => (e.currentTarget.open ? setOpenTweak(r.key) : open === r.key && setOpenTweak(null))}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between px-6 py-4 font-medium">
              {r.title}
              <ChevronRight className="size-5 text-muted-foreground transition-transform group-open:rotate-90" />
            </summary>
            <div className="grid grid-cols-3 gap-3 px-6 pb-5">
              {POS.map((o) => {
                const on = tweaks[r.key] === o;
                return (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={on}
                    onClick={() => !on && setTweaks({ [r.key]: o })}
                    className={`flex flex-col items-center gap-2.5 rounded-lg border py-4 text-xs capitalize ${
                      on ? "border-foreground" : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    <Slots pos={o} />
                    {o}
                  </button>
                );
              })}
            </div>
          </details>
        ))}
        <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
          {status.kind === "busy" ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {status.text}
            </span>
          ) : status.kind === "done" ? (
            <a className="text-blue-600 underline underline-offset-4" href={`http://localhost:3001/how-to/${status.text || "filtering-tasks"}`} target="_blank">
              Docs updated, see the new GIFs
            </a>
          ) : status.kind === "error" ? (
            <span className="truncate text-destructive" title={status.text}>
              Update failed: {status.text}
            </span>
          ) : (
            <span className="text-muted-foreground">{dirty ? "Unsaved changes" : status.text || "Move things, then press Done"}</span>
          )}
          <Button size="sm" disabled={!dirty || status.kind === "busy"} onClick={() => updateDocs(setStatus)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
