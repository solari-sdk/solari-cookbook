import OpenAI from "openai";
import {
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  TEARDOWN_SCHEMA,
  buildUserPrompt,
  parseTeardown,
} from "./prompt";
import type { ScrapeBundle, Teardown } from "./types";

/** Chat-completions models only — embeddings, audio, and image ids are noise. */
const NON_CHAT = /embed|whisper|tts|dall-e|moderation|audio|image|realtime|search|transcribe/i;

export async function synthesizeWithOpenAI(
  bundle: ScrapeBundle,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<Teardown> {
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create(
    {
      model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(bundle) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "competitive_teardown",
          strict: true,
          schema: TEARDOWN_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    },
    { signal },
  );

  const choice = response.choices[0];
  if (choice?.finish_reason === "content_filter") {
    throw new Error("OpenAI's content filter blocked the response.");
  }

  return parseTeardown(choice?.message?.content ?? "", "OpenAI");
}

export async function listOpenAIModels(apiKey: string): Promise<string[]> {
  const client = new OpenAI({ apiKey });
  const page = await client.models.list();
  return page.data
    .map((model) => model.id)
    .filter((id) => !NON_CHAT.test(id))
    .sort();
}
