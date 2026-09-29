import { NextResponse } from "next/server";
import { listModels } from "@/lib/llm";
import { describeLlmError, getProvider, isLlmProvider } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lists the models a bring-your-own key can actually use, which doubles as key
 * validation before a run is started. The key is used for this one request and
 * is never stored or logged.
 */
export async function POST(request: Request) {
  let payload: { provider?: unknown; apiKey?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!isLlmProvider(payload.provider)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "An API key is required." }, { status: 400 });
  }

  const provider = getProvider(payload.provider)!;

  try {
    const models = await listModels(payload.provider, apiKey);
    return NextResponse.json({
      models,
      defaultModel: models.includes(provider.defaultModel)
        ? provider.defaultModel
        : (models[0] ?? provider.defaultModel),
    });
  } catch (err) {
    return NextResponse.json(
      { error: describeLlmError(err, provider.label) },
      { status: 400 },
    );
  }
}
