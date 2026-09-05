import { parseModelJson } from "./parse.js"
import { DRAFT_SYSTEM, VERIFY_SYSTEM } from "./prompts.js"
import type { Citation } from "./schemas.js"
import type { Model } from "./pipeline.js"

export interface ProviderConfig {
  url: string
  apiKey: string
  model: string
  /** NVIDIA reasoning models. Ignored elsewhere. */
  reasoningEffort?: string
  maxTokens?: number
  /** Injected in tests so the suite never reaches the network. */
  fetchImpl?: typeof fetch
  /** Base backoff. Zero in tests. */
  retryDelayMs?: number
  maxAttempts?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 429 and 5xx are scheduling problems. 4xx is a bug — retrying buries it. */
const isRetryable = (status: number) => status === 429 || (status >= 500 && status < 600)

export const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions"
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

async function complete(cfg: ProviderConfig, system: string, user: string): Promise<string> {
  const maxAttempts = cfg.maxAttempts ?? 5
  const baseDelay = cfg.retryDelayMs ?? 2000
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptComplete(cfg, system, user)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === undefined || !isRetryable(status) || attempt === maxAttempts) throw err
      lastError = err as Error
      await sleep(baseDelay * 2 ** (attempt - 1))
    }
  }

  throw lastError ?? new Error("unreachable")
}

async function attemptComplete(cfg: ProviderConfig, system: string, user: string): Promise<string> {
  const doFetch = cfg.fetchImpl ?? fetch
  const res = await doFetch(cfg.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      max_tokens: cfg.maxTokens ?? 16384,
      temperature: 1,
      // No `seed`. A fixed seed makes repeated runs identical, which would hide
      // exactly the instability the M0 gate exists to detect.
      ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  })

  if (!res.ok) {
    const err = new Error(`${cfg.model} ${res.status}: ${(await res.text()).slice(0, 300)}`) as Error & { status: number }
    err.status = res.status
    throw err
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: string; reasoning?: string } }[]
  }
  const message = body.choices?.[0]?.message
  // Reasoning models sometimes leave `content` empty and put the payload in
  // `reasoning`. Falling back beats reporting a spurious parse failure.
  return message?.content || message?.reasoning || ""
}

export function liveModel(cfg: ProviderConfig): Model {
  return {
    draft: async (corpus, question) =>
      parseModelJson(
        await complete(cfg, DRAFT_SYSTEM, `<evidence>\n${corpus}\n</evidence>\n\nQuestion: ${question}`),
      ),

    verify: async (question, answer, citations: Citation[]) =>
      parseModelJson(
        await complete(
          cfg,
          VERIFY_SYSTEM,
          `QUESTION: ${question}\n\nDRAFTED ANSWER: ${answer}\n\nQUOTES:\n${
            citations.map((c) => `- [${c.document}] "${c.quote}"`).join("\n") || "(none cited)"
          }`,
        ),
      ),
  }
}
