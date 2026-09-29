import type { LlmProvider } from "./types";

/**
 * Provider metadata, deliberately free of SDK imports so client components can
 * use it without pulling the Anthropic/OpenAI/Gemini SDKs into the browser
 * bundle. The adapters live in lib/llm.ts.
 */
export interface ProviderInfo {
  id: LlmProvider;
  label: string;
  defaultModel: string;
  /** Shown in the key field so users know what they are pasting. */
  keyHint: string;
  keysUrl: string;
}

export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";
export const OPENAI_DEFAULT_MODEL = "gpt-4.1";
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Bring-your-own-key: the app ships no LLM credentials. A key arrives with the
 * run request, is used for exactly one call, and is never written to the run
 * record, the event log, or any response.
 */
export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude",
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    keyHint: "sk-ant-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: OPENAI_DEFAULT_MODEL,
    keyHint: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    label: "Gemini",
    defaultModel: GEMINI_DEFAULT_MODEL,
    keyHint: "AIza…",
    keysUrl: "https://aistudio.google.com/apikey",
  },
];

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && PROVIDERS.some((p) => p.id === value);
}

/**
 * Turn a provider SDK error into something a user can act on, without ever
 * echoing the key back.
 */
export function describeLlmError(err: unknown, providerLabel: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;

  if (status === 401 || /invalid.*api key|unauthorized|API_KEY_INVALID/i.test(message)) {
    return `${providerLabel} rejected the API key. Check that it is valid and has not been revoked.`;
  }
  if (status === 429 || /rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(message)) {
    return `${providerLabel} rate-limited the request, or the key has no remaining quota.`;
  }
  if (status === 404 || /model.*not found|does not exist|NOT_FOUND/i.test(message)) {
    return `${providerLabel} does not recognise that model for this key. Pick another model.`;
  }
  if (status === 403) {
    return `${providerLabel} refused the request — the key may lack access to this model.`;
  }
  return `${providerLabel}: ${message}`;
}
