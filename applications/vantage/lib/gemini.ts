import { GoogleGenAI } from "@google/genai";
import {
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  TEARDOWN_SCHEMA,
  buildUserPrompt,
  parseTeardown,
  toGeminiSchema,
} from "./prompt";
import type { ScrapeBundle, Teardown } from "./types";

const GEMINI_SCHEMA = toGeminiSchema(TEARDOWN_SCHEMA);

export async function synthesizeWithGemini(
  bundle: ScrapeBundle,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<Teardown> {
  const client = new GoogleGenAI({ apiKey });

  const response = await client.models.generateContent({
    model,
    contents: buildUserPrompt(bundle),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      // `responseJsonSchema` takes standard JSON Schema; `responseSchema` is
      // the older OpenAPI-flavoured field.
      responseJsonSchema: GEMINI_SCHEMA,
      // Gemini 2.5 thinks by default, and thinking tokens are billed against
      // the *same* `maxOutputTokens` budget as the answer. With a schema this
      // large the model would spend the budget reasoning and get cut off
      // mid-object, which surfaced as "returned output that was not valid
      // JSON". This is structured extraction from supplied text, not a
      // reasoning problem, so the budget goes entirely to the answer.
      thinkingConfig: { thinkingBudget: 0 },
      abortSignal: signal,
    },
  });

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      `Gemini hit the ${MAX_OUTPUT_TOKENS}-token output limit before finishing the report. Try a smaller target or a model with more headroom.`,
    );
  }
  if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
    throw new Error("Gemini blocked the response for this target.");
  }

  return parseTeardown(response.text ?? "", "Gemini");
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const client = new GoogleGenAI({ apiKey });
  const models: string[] = [];

  for await (const model of await client.models.list()) {
    const actions = model.supportedActions ?? [];
    if (actions.length > 0 && !actions.includes("generateContent")) continue;
    const id = (model.name ?? "").replace(/^models\//, "");
    if (id && !/embedding|aqa|imagen|veo|tts/i.test(id)) models.push(id);
  }

  return models.sort();
}
