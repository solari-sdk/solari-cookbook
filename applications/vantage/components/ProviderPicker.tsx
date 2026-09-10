"use client";

import { useState } from "react";
import { PROVIDERS } from "@/lib/providers";
import {
  MODEL_STORAGE_KEY,
  PROVIDER_STORAGE_KEY,
  apiKeyStorageKey,
} from "@/lib/storage-keys";
import type { LlmProvider } from "@/lib/types";

export interface ProviderState {
  provider: LlmProvider;
  apiKey: string;
  model: string;
}

export { MODEL_STORAGE_KEY, PROVIDER_STORAGE_KEY } from "@/lib/storage-keys";

const keyStorageKey = apiKeyStorageKey;

function rememberModel(model: string): void {
  try {
    sessionStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {}
}

export function readStoredKey(provider: LlmProvider): string {
  try {
    return sessionStorage.getItem(keyStorageKey(provider)) ?? "";
  } catch {
    return "";
  }
}

export default function ProviderPicker({
  value,
  onChange,
  disabled,
}: {
  value: ProviderState;
  onChange: (next: ProviderState) => void;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const active = PROVIDERS.find((p) => p.id === value.provider) ?? PROVIDERS[0];

  function selectProvider(provider: LlmProvider) {
    if (disabled || provider === value.provider) return;
    setModels([]);
    setVerified(false);
    setVerifyError(null);
    const info = PROVIDERS.find((p) => p.id === provider)!;
    try {
      sessionStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    } catch {}
    rememberModel(info.defaultModel);
    onChange({
      provider,
      apiKey: readStoredKey(provider),
      model: info.defaultModel,
    });
  }

  function setKey(apiKey: string) {
    setVerified(false);
    setVerifyError(null);
    setModels([]);
    try {
      if (apiKey) sessionStorage.setItem(keyStorageKey(value.provider), apiKey);
      else sessionStorage.removeItem(keyStorageKey(value.provider));
    } catch {}
    onChange({ ...value, apiKey });
  }

  function forgetKey() {
    try {
      for (const provider of PROVIDERS) {
        sessionStorage.removeItem(keyStorageKey(provider.id));
      }
    } catch {}
    setModels([]);
    setVerified(false);
    setVerifyError(null);
    onChange({ ...value, apiKey: "" });
  }

  async function verify() {
    if (!value.apiKey.trim() || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: value.provider, apiKey: value.apiKey }),
      });
      const data = (await response.json()) as {
        models?: string[];
        defaultModel?: string;
        error?: string;
      };
      if (!response.ok || !data.models) {
        setVerifyError(data.error ?? "Could not reach the provider.");
        return;
      }
      setModels(data.models);
      setVerified(true);
      const model = data.models.includes(value.model)
        ? value.model
        : (data.defaultModel ?? data.models[0] ?? value.model);
      rememberModel(model);
      onChange({ ...value, model });
    } catch {
      setVerifyError("Network error while contacting the provider.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <fieldset disabled={disabled} className="space-y-5 disabled:opacity-60">
      <legend className="sr-only">Model provider and key</legend>

      {/* Step 1 — provider */}
      <section>
        <StepHeading index="1" title="Choose a provider" />
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {PROVIDERS.map((provider) => {
            const isActive = provider.id === value.provider;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => selectProvider(provider.id)}
                aria-pressed={isActive}
                className={`group relative rounded-xl border p-3.5 text-left transition-colors ${
                  isActive
                    ? "border-accent/60 bg-accent/[0.07]"
                    : "border-white/10 bg-white/[0.02] hover:border-white/25"
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    {provider.label}
                  </span>
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${
                      isActive
                        ? "border-accent bg-accent text-background"
                        : "border-white/20 text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                </span>
                <span className="mt-1.5 block truncate font-mono text-[11px] text-faint">
                  {provider.defaultModel}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Step 2 — key */}
      <section>
        <StepHeading index="2" title={`Paste your ${active.label} key`}>
          <a
            href={active.keysUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline"
          >
            Get a key ↗
          </a>
        </StepHeading>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div
            className={`flex flex-1 items-center gap-2 rounded-xl border bg-white/[0.02] px-3 transition-colors focus-within:border-accent/60 ${
              verifyError ? "border-danger/50" : "border-white/10"
            }`}
          >
            <input
              type={revealed ? "text" : "password"}
              value={value.apiKey}
              onChange={(event) => setKey(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder={active.keyHint}
              aria-label={`${active.label} API key`}
              className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground placeholder:text-faint focus:outline-none"
            />
            {value.apiKey && (
              <button
                type="button"
                onClick={() => setRevealed((on) => !on)}
                className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-faint hover:text-muted"
                aria-label={revealed ? "Hide key" : "Show key"}
              >
                {revealed ? "hide" : "show"}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={verify}
            disabled={!value.apiKey.trim() || verifying}
            className={`h-11 shrink-0 rounded-xl px-4 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${
              verified
                ? "border border-ok/40 bg-ok/10 text-ok"
                : "bg-foreground text-background hover:opacity-90"
            }`}
          >
            {verifying ? "Checking…" : verified ? "Verified ✓" : "Verify key"}
          </button>
        </div>

        <p className="mt-2.5 min-h-[1.25rem] text-[12.5px] leading-relaxed">
          {verifyError ? (
            <span className="text-danger">{verifyError}</span>
          ) : verified ? (
            <span className="text-ok">
              Key accepted — {models.length} models available.
            </span>
          ) : (
            <span className="text-faint">
              Verifying loads the models this key can actually use.
            </span>
          )}
        </p>
      </section>

      {/* Step 3 — model */}
      <section>
        <StepHeading index="3" title="Pick a model">
          {models.length > 0 && (
            <span className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-faint">
              {models.length} available
            </span>
          )}
        </StepHeading>

        <div className="mt-3">
          {models.length > 0 ? (
            <select
              id="model-select"
              value={value.model}
              onChange={(event) => {
                rememberModel(event.target.value);
                onChange({ ...value, model: event.target.value });
              }}
              className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.02] px-3 font-mono text-[13px] text-foreground focus:border-accent/60 focus:outline-none"
            >
              {models.map((model) => (
                <option key={model} value={model} className="bg-surface">
                  {model}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="model-select"
              value={value.model}
              onChange={(event) => {
                rememberModel(event.target.value);
                onChange({ ...value, model: event.target.value });
              }}
              spellCheck={false}
              className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.02] px-3 font-mono text-[13px] text-foreground focus:border-accent/60 focus:outline-none"
            />
          )}
        </div>

        {value.apiKey && (
          <button
            type="button"
            onClick={forgetKey}
            className="mt-3 font-mono text-[11px] text-faint underline-offset-2 hover:text-danger hover:underline"
          >
            forget stored key
          </button>
        )}
      </section>
    </fieldset>
  );
}

function StepHeading({
  index,
  title,
  children,
}: {
  index: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-white/12 bg-white/[0.04] font-mono text-[10px] text-muted">
        {index}
      </span>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <span className="h-px flex-1 bg-white/8" />
      {children}
    </div>
  );
}
