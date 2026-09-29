import { listAnthropicModels, synthesizeWithClaude } from "./claude";
import { listGeminiModels, synthesizeWithGemini } from "./gemini";
import { listOpenAIModels, synthesizeWithOpenAI } from "./openai";
import { getProvider } from "./providers";
import type { LlmCredentials, LlmProvider, ScrapeBundle, Teardown } from "./types";

export {
  PROVIDERS,
  getProvider,
  isLlmProvider,
  describeLlmError,
  type ProviderInfo,
} from "./providers";

/** Dispatch synthesis to the chosen provider. Server-only: pulls the SDKs. */
export async function synthesizeTeardown(
  bundle: ScrapeBundle,
  credentials: LlmCredentials,
  signal?: AbortSignal,
): Promise<Teardown> {
  const provider = getProvider(credentials.provider);
  if (!provider) {
    throw new Error(`Unknown provider "${credentials.provider}".`);
  }
  const model = credentials.model?.trim() || provider.defaultModel;

  switch (credentials.provider) {
    case "anthropic":
      return synthesizeWithClaude(bundle, credentials.apiKey, model, signal);
    case "openai":
      return synthesizeWithOpenAI(bundle, credentials.apiKey, model, signal);
    case "gemini":
      return synthesizeWithGemini(bundle, credentials.apiKey, model, signal);
  }
}

/** List the models a key can use. Doubles as key validation. */
export async function listModels(
  provider: LlmProvider,
  apiKey: string,
): Promise<string[]> {
  switch (provider) {
    case "anthropic":
      return listAnthropicModels(apiKey);
    case "openai":
      return listOpenAIModels(apiKey);
    case "gemini":
      return listGeminiModels(apiKey);
  }
}
