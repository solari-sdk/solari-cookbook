// SPDX-License-Identifier: AGPL-3.0-only
// A dev-build panel for tuning the window's dark material live: each slider writes one CSS variable on the root, the
// values persist in this browser, and Copy hands back the numbers to lock into index.css. Toggle with ⌘⇧M.
import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, RotateCcwIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";

type Knob = { key: string; label: string; hint: string; min: number; max: number; locked: number };

const KNOBS: readonly Knob[] = [
  { key: "--material-centre", label: "Chat column", hint: "#060606 over the glass", min: 0, max: 100, locked: 67 },
  { key: "--material-panel", label: "Right panel", hint: "#060606 over the glass", min: 0, max: 100, locked: 74 },
  { key: "--material-sidebar", label: "Left sidebar", hint: "#060606 over the glass", min: 0, max: 100, locked: 40 },
  { key: "--material-line", label: "Panel lines", hint: "white hairline", min: 0, max: 30, locked: 10 },
  { key: "--material-card", label: "Panel cards", hint: "white tint", min: 0, max: 15, locked: 2 },
];

const STORE = "wsp.dev.material";

function readSaved(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function apply(values: Record<string, number>): void {
  for (const k of KNOBS) {
    const v = values[k.key];
    if (v === undefined || v === k.locked) document.documentElement.style.removeProperty(k.key);
    else document.documentElement.style.setProperty(k.key, `${v}%`);
  }
}

export function MaterialTuner() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, number>>(readSaved);
  const [copied, setCopied] = useState(false);

  useEffect(() => apply(values), [values]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = (key: string, v: number): void => {
    const next = { ...values, [key]: v };
    setValues(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {}
  };
  const reset = (): void => {
    setValues({});
    try {
      localStorage.removeItem(STORE);
    } catch {}
  };
  const copy = (): void => {
    const text = KNOBS.map(k => `${k.key}: ${values[k.key] ?? k.locked}%;`).join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (!open) return null;
  return (
    <div className="fixed right-4 bottom-4 z-[100] w-80 rounded-xl border border-border bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur-md">
      <div className="mb-4 flex items-center gap-2">
        <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">Material</span>
        <span className="flex gap-3 font-mono text-[11px] text-muted-foreground"><span>dark</span><span>⌘⇧M</span></span>
        <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="ms-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-4">
        {KNOBS.map(k => {
          const v = values[k.key] ?? k.locked;
          return (
            <label key={k.key} className="flex flex-col gap-1.5">
              <span className="flex items-baseline gap-2">
                <span className="text-[13px]">{k.label}</span>
                <span className="text-[11px] text-muted-foreground">{k.hint}</span>
                <span className="ms-auto font-mono text-xs tabular-nums">{v}%</span>
              </span>
              <input type="range" min={k.min} max={k.max} step={1} value={v} onChange={e => set(k.key, Number(e.target.value))} className="w-full accent-foreground" />
            </label>
          );
        })}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={copy} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-border text-xs hover:bg-accent">
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy values"}
        </button>
        <button type="button" onClick={reset} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-accent">
          <RotateCcwIcon className="size-3.5" />
          Locked values
        </button>
      </div>
    </div>
  );
}
