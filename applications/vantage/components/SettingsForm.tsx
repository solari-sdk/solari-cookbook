"use client";

import { useState } from "react";
import Link from "next/link";
import ProviderPicker, { readStoredKey, type ProviderState } from "./ProviderPicker";
import { PROVIDERS, isLlmProvider } from "@/lib/providers";
import { MODEL_STORAGE_KEY, PROVIDER_STORAGE_KEY } from "@/lib/storage-keys";

/** Restore the last provider choice, key, and model from this tab's storage. */
function initialState(): ProviderState {
  const fallback = PROVIDERS[0];
  try {
    const stored = sessionStorage.getItem(PROVIDER_STORAGE_KEY);
    const provider = isLlmProvider(stored) ? stored : fallback.id;
    const info = PROVIDERS.find((p) => p.id === provider) ?? fallback;
    return {
      provider,
      apiKey: readStoredKey(provider),
      model: sessionStorage.getItem(MODEL_STORAGE_KEY) || info.defaultModel,
    };
  } catch {
    return { provider: fallback.id, apiKey: "", model: fallback.defaultModel };
  }
}

const KEY_FACTS = [
  {
    title: "Tab-scoped only",
    body: "Stored in this browser tab's sessionStorage. Closing the tab discards it.",
  },
  {
    title: "Never persisted server-side",
    body: "Sent with each run, used for exactly one call, never written to the run record, the event log, or any response.",
  },
  {
    title: "Use HTTPS in production",
    body: "Over plain HTTP the key would cross the network in clear text.",
  },
];

export default function SettingsForm() {
  const [llm, setLlm] = useState<ProviderState>(initialState);
  const configured = llm.apiKey.trim().length > 0;
  const providerLabel =
    PROVIDERS.find((p) => p.id === llm.provider)?.label ?? llm.provider;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-14 sm:py-16">
      {/* Masthead */}
      <header className="border-b border-white/10 pb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="h-px w-6 bg-accent/60" />
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
                Settings
              </p>
            </div>
            <h1 className="display mt-4 text-3xl sm:text-4xl">
              Bring your own model key
            </h1>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
              Vantage pays for the browser that does the research. The synthesis
              step runs on your key, with the provider and model you choose here.
            </p>
          </div>

          <div
            className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] ${
              configured ? "border-ok/30 text-ok" : "border-warn/30 text-warn"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                configured ? "bg-ok" : "bg-warn pulse-dot"
              }`}
            />
            {configured ? "Key configured" : "No key yet"}
          </div>
        </div>
      </header>

      <div className="grid gap-10 pt-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* Form */}
        <div className="glass rounded-2xl p-6 sm:p-7">
          <ProviderPicker value={llm} onChange={setLlm} />
        </div>

        {/* Sidebar */}
        <aside className="space-y-6">
          <section>
            <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
              Where your key goes
            </h2>
            <ul className="mt-4 space-y-4">
              {KEY_FACTS.map((fact) => (
                <li key={fact.title}>
                  <p className="text-[13px] font-medium text-foreground">
                    {fact.title}
                  </p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                    {fact.body}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-dashed border-white/12 p-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">
              No key handy?
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
              The examples on the home page replay saved runs, so you can see a
              full teardown without spending anything.
            </p>
          </section>
        </aside>
      </div>

      {/* Footer action */}
      <div className="mt-10 flex flex-wrap items-center gap-4 border-t border-white/10 pt-6">
        <Link
          href="/"
          className="rounded-lg bg-foreground px-5 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          {configured ? "Run Agent →" : "← Back to home"}
        </Link>
        {configured && (
          <span className="font-mono text-[11px] text-faint">
            Ready · {providerLabel} / {llm.model}
          </span>
        )}
      </div>
    </div>
  );
}
