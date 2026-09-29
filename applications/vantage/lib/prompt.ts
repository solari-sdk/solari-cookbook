import type { ScrapeBundle, Teardown } from "./types";

/**
 * Output ceiling for the teardown.
 *
 * A completed teardown runs ~2-3k tokens, so 6k is generous. It used to be 16k,
 * which was actively harmful: OpenAI counts `max_tokens` against your
 * tokens-per-minute budget as a *reservation*, so a 16k ceiling plus a ~10k
 * dossier consumed ~26k TPM per call and tripped a 429 on lower tiers before
 * the model had generated a single token.
 */
export const MAX_OUTPUT_TOKENS = 6_000;

/** Rough token estimate for the live feed. ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Provider-agnostic prompt layer. Anthropic, OpenAI, and Gemini all get the
 * same system prompt, the same JSON schema, and the same rendered dossier, so
 * the only thing that varies between providers is the transport.
 */

export const SYSTEM_PROMPT = `You are a product analyst producing competitive teardowns for a founder deciding whether and how to compete with this company.

Rules:
- Ground every claim in the supplied scrape. If the evidence is thin, say so in "gaps" and lower "confidence" rather than inventing detail.
- Never state a price, funding round, customer name, or date that does not appear in the source material.
- Prefer specifics over adjectives. "Team plan is $20/user/month, annual only" beats "reasonably priced".
- Complaints must come from the search, ProductHunt, or Hacker News material, not from your priors about the category. If none surfaced, return an empty list and note it in "gaps".
- Hacker News entries carry a date, a score, and a comment count. Treat a high score or heavy comment volume as a signal that a move mattered, and use those dates for "recentMoves" rather than guessing.
- GitHub repo languages and push dates are evidence about the stack and about momentum. An org with no public repos is not evidence of anything — say so instead of inferring.
- Opportunities must be actionable wedges a small competitor could ship, each tied to something observed in the data.
- The tech-stack signals were detected deterministically from page assets. Interpret what they imply about the team; do not add tools that were not detected.`;

/** Mirrors the `Teardown` interface. Kept in sync by hand — see lib/types.ts. */
export const TEARDOWN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "company",
    "headline",
    "positioning",
    "pricing",
    "techStack",
    "complaints",
    "recentMoves",
    "opportunities",
    "confidence",
    "gaps",
  ],
  properties: {
    company: { type: "string", description: "Company name as they style it." },
    headline: {
      type: "string",
      description: "One sentence, under 140 characters: what they are and who for.",
    },
    positioning: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "targetCustomer", "valueProps", "differentiators"],
      properties: {
        summary: { type: "string" },
        targetCustomer: { type: "string" },
        valueProps: { type: "array", items: { type: "string" }, maxItems: 6 },
        differentiators: { type: "array", items: { type: "string" }, maxItems: 6 },
      },
    },
    pricing: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "model", "freeTier", "tiers"],
      properties: {
        summary: { type: "string" },
        model: {
          type: "string",
          description: 'e.g. "per-seat subscription", "usage-based", "sales-led / no public pricing".',
        },
        freeTier: {
          type: "string",
          description: 'Describe the free tier or trial, or "none found".',
        },
        tiers: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "price", "notes"],
            properties: {
              name: { type: "string" },
              price: { type: "string" },
              notes: { type: "string" },
            },
          },
        },
      },
    },
    techStack: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "signals"],
      properties: {
        summary: {
          type: "string",
          description: "What the detected stack implies about team size, maturity, and motion.",
        },
        signals: {
          type: "array",
          maxItems: 25,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "category", "evidence"],
            properties: {
              name: { type: "string" },
              category: {
                type: "string",
                enum: [
                  "framework",
                  "analytics",
                  "hosting",
                  "payments",
                  "support",
                  "marketing",
                  "auth",
                  "other",
                ],
              },
              evidence: { type: "string" },
            },
          },
        },
      },
    },
    complaints: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "items"],
      properties: {
        summary: { type: "string" },
        items: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["complaint", "source", "severity"],
            properties: {
              complaint: { type: "string" },
              source: { type: "string", description: "Where it surfaced (title or domain)." },
              severity: { type: "string", enum: ["low", "medium", "high"] },
            },
          },
        },
      },
    },
    recentMoves: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "items"],
      properties: {
        summary: { type: "string" },
        items: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["when", "move", "source"],
            properties: {
              when: { type: "string", description: 'Date or period, or "unknown".' },
              move: { type: "string" },
              source: { type: "string" },
            },
          },
        },
      },
    },
    opportunities: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "items"],
      properties: {
        summary: { type: "string" },
        items: {
          type: "array",
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["gap", "why", "howToExploit"],
            properties: {
              gap: { type: "string" },
              why: { type: "string" },
              howToExploit: { type: "string" },
            },
          },
        },
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    gaps: {
      type: "array",
      maxItems: 8,
      items: { type: "string" },
      description: "What the scrape could not establish.",
    },
  },
} as const;


/** Flatten the scrape into a compact, clearly-delimited prompt document. */
export function renderScrapeForPrompt(bundle: ScrapeBundle): string {
  const parts: string[] = [];

  parts.push(
    `# TARGET\nInput URL: ${bundle.target.inputUrl}\nHost: ${bundle.target.host}\nDerived name: ${bundle.target.company}`,
  );

  for (const page of bundle.pages) {
    if (page.ok) {
      parts.push(
        `# PAGE: ${page.label}\nURL: ${page.finalUrl ?? page.url}\nTitle: ${page.title ?? "(none)"}\n\n${page.text ?? ""}`,
      );
    } else {
      parts.push(`# PAGE: ${page.label}\nURL: ${page.url}\nFAILED: ${page.error}`);
    }
  }

  if (bundle.techSignals.length > 0) {
    parts.push(
      `# TECH SIGNALS (detected from page assets)\n${bundle.techSignals
        .map((s) => `- ${s.name} [${s.category}] — ${s.evidence}`)
        .join("\n")}`,
    );
  } else {
    parts.push("# TECH SIGNALS\nNone detected.");
  }

  for (const search of [...bundle.searches, bundle.productHunt]) {
    if (search.ok && search.results.length > 0) {
      parts.push(
        `# SEARCH: ${search.query}\n${search.results
          .map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`)
          .join("\n")}`,
      );
    } else {
      parts.push(`# SEARCH: ${search.query}\nNo results (${search.error ?? "empty"}).`);
    }
  }

  if (bundle.hackerNews.hits.length > 0) {
    parts.push(
      `# HACKER NEWS (dated, with score and comment volume)\n${bundle.hackerNews.hits
        .map(
          (h) =>
            `- ${h.date} · ${h.points} points · ${h.comments} comments — ${h.title}\n  ${h.url}\n  discussion: ${h.discussionUrl}`,
        )
        .join("\n")}`,
    );
  } else {
    parts.push(
      `# HACKER NEWS\nNo stories found (${bundle.hackerNews.error ?? "no matches"}).`,
    );
  }

  if (bundle.github.ok && bundle.github.repos.length > 0) {
    parts.push(
      `# GITHUB: @${bundle.github.org}\n${bundle.github.repos
        .map(
          (r) =>
            `- ${r.name} · ${r.stars} stars · ${r.language || "n/a"} · last push ${r.lastPush}\n  ${r.description}`,
        )
        .join("\n")}`,
    );
  } else {
    parts.push(`# GITHUB\nNot resolved (${bundle.github.error ?? "no org"}).`);
  }

  return parts.join("\n\n---\n\n");
}


/** The user-turn instruction. Identical across providers. */
export function buildUserPrompt(bundle: ScrapeBundle): string {
  return `Produce a competitive teardown of ${bundle.target.company} (${bundle.target.origin}) from the scraped material below.\n\n${renderScrapeForPrompt(bundle)}`;
}

/**
 * Gemini's structured-output validator rejects several standard JSON Schema
 * keywords. Strip them rather than maintaining a second schema by hand.
 */
export function toGeminiSchema(schema: unknown): unknown {
  const DROP = new Set(["additionalProperties", "maxItems", "minItems"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (DROP.has(key)) continue;
        out[key] = walk(value);
      }
      return out;
    }
    return node;
  };
  return walk(schema);
}

/**
 * Parse a model's JSON answer. Models occasionally wrap the object in a fenced
 * code block even under a schema constraint, so unwrap before parsing.
 */
export function parseTeardown(raw: string, providerLabel: string): Teardown {
  const text = raw.trim();
  if (!text) {
    throw new Error(`${providerLabel} returned an empty response.`);
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate) as Teardown;
  } catch {
    // Last resort: take the outermost object.
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1)) as Teardown;
      } catch {
        // fall through
      }
    }
    // Include the tail: a response cut off mid-object looks completely
    // different from one wrapped in prose, and the message should say which.
    const tail = candidate.slice(-120).replace(/\s+/g, " ");
    const looksTruncated = !candidate.trimEnd().endsWith("}");
    throw new Error(
      `${providerLabel} returned output that was not valid JSON` +
        (looksTruncated ? " (it was cut off mid-object — the output token limit was likely hit)" : "") +
        `. Ends with: …${tail}`,
    );
  }
}
