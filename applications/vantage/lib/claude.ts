import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  TEARDOWN_SCHEMA,
  buildUserPrompt,
  parseTeardown,
} from "./prompt";
import type { ScrapeBundle, Teardown } from "./types";

/**
 * Anthropic adapter. Pure: credentials and input in, teardown out — no stores
 * touched, nothing cached, and the key never leaves this call.
 */
export async function synthesizeWithClaude(
  bundle: ScrapeBundle,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<Teardown> {
  const client = new Anthropic({ apiKey });

  // Haiku 4.5 accepts neither adaptive thinking nor `output_config.effort`
  // (both are a 400 there), and the Opus/Sonnet tiers are happy without them,
  // so the request stays identical whichever Claude model the user picks.
  const stream = client.messages.stream(
    {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: {
        format: {
          type: "json_schema",
          schema: TEARDOWN_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      messages: [{ role: "user", content: buildUserPrompt(bundle) }],
    },
    { signal },
  );

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(
      `Claude declined to analyse this target (${message.stop_details?.category ?? "unspecified"}).`,
    );
  }

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseTeardown(text, "Claude");
}

/** Model ids the key can actually use — populates the model picker. */
export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const page = await client.models.list({ limit: 50 });
  return page.data.map((model) => model.id);
}
