/** Shared types for the Competitive Intelligence Agent. */

export type RunStatus = "queued" | "running" | "done" | "error";

export type LlmProvider = "anthropic" | "openai" | "gemini";

/**
 * Bring-your-own-key credentials for one run. These live only in the request
 * and the in-flight closure — never in the run record, the event log, or any
 * response body.
 */
export interface LlmCredentials {
  provider: LlmProvider;
  apiKey: string;
  /** Empty falls back to the provider's default model. */
  model?: string;
}

/**
 * A presigned link to the recorded browser session. Captured after the session
 * is released, so it survives a failed synthesis — a run that died is exactly
 * when you most want to watch what the agent saw.
 */
export interface SessionReplay {
  sessionId: string;
  url: string;
  /** Lifetime of the presigned URL itself, as reported by Solari. */
  expiresInSeconds: number;
  /** When the URL was minted, so the client can work out the deadline. */
  capturedAt: number;
}

export type EventLevel = "info" | "ok" | "warn" | "error";

export interface AgentEvent {
  seq: number;
  ts: number;
  level: EventLevel;
  /** Short machine-ish phase tag shown in the monospace feed, e.g. "scrape". */
  phase: string;
  message: string;
}

/** Emitted by the agent as it works. Injected so agent.ts stays side-effect free. */
export type EventSink = (
  level: EventLevel,
  phase: string,
  message: string,
) => void;

/* ------------------------------------------------------------------ */
/* Raw scrape layer                                                    */
/* ------------------------------------------------------------------ */

export interface ScrapedPage {
  label: string;
  url: string;
  ok: boolean;
  finalUrl?: string;
  title?: string;
  /** Visible text, whitespace-collapsed and truncated. */
  text?: string;
  error?: string;
}

export interface TechSignal {
  name: string;
  category:
    | "framework"
    | "analytics"
    | "hosting"
    | "payments"
    | "support"
    | "marketing"
    | "auth"
    | "other";
  evidence: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchBundle {
  query: string;
  ok: boolean;
  results: SearchResult[];
  error?: string;
}

export interface HackerNewsHit {
  title: string;
  url: string;
  discussionUrl: string;
  points: number;
  comments: number;
  /** ISO date, YYYY-MM-DD. */
  date: string;
}

export interface HackerNewsBundle {
  query: string;
  ok: boolean;
  hits: HackerNewsHit[];
  error?: string;
}

export interface GithubRepo {
  name: string;
  url: string;
  description: string;
  stars: number;
  language: string;
  /** ISO date, YYYY-MM-DD. */
  lastPush: string;
}

export interface GithubBundle {
  org: string | null;
  ok: boolean;
  repos: GithubRepo[];
  error?: string;
}

export interface ScrapeBundle {
  target: {
    inputUrl: string;
    origin: string;
    host: string;
    /** Best-effort company name derived from the domain / <title>. */
    company: string;
  };
  pages: ScrapedPage[];
  techSignals: TechSignal[];
  searches: SearchBundle[];
  productHunt: SearchBundle;
  hackerNews: HackerNewsBundle;
  github: GithubBundle;
  startedAt: number;
  finishedAt: number;
}

/* ------------------------------------------------------------------ */
/* Synthesised teardown (Claude output)                                */
/* ------------------------------------------------------------------ */

export interface PricingTier {
  name: string;
  price: string;
  notes: string;
}

export interface ComplaintItem {
  complaint: string;
  source: string;
  severity: "low" | "medium" | "high";
}

export interface MoveItem {
  when: string;
  move: string;
  source: string;
}

export interface OpportunityItem {
  gap: string;
  why: string;
  howToExploit: string;
}

export interface Teardown {
  company: string;
  headline: string;
  positioning: {
    summary: string;
    targetCustomer: string;
    valueProps: string[];
    differentiators: string[];
  };
  pricing: {
    summary: string;
    model: string;
    freeTier: string;
    tiers: PricingTier[];
  };
  techStack: {
    summary: string;
    signals: TechSignal[];
  };
  complaints: {
    summary: string;
    items: ComplaintItem[];
  };
  recentMoves: {
    summary: string;
    items: MoveItem[];
  };
  opportunities: {
    summary: string;
    items: OpportunityItem[];
  };
  confidence: "low" | "medium" | "high";
  gaps: string[];
}

/* ------------------------------------------------------------------ */
/* Run record (server-side, in-memory)                                 */
/* ------------------------------------------------------------------ */

export interface RunRecord {
  id: string;
  url: string;
  /** Which provider/model synthesised this run. The key is never stored. */
  provider: LlmProvider;
  model: string;
  /** True when this is a replay of a previously captured run, not a live one. */
  demo?: boolean;
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
  events: AgentEvent[];
  report?: Teardown;
  /** Present once the browser session has been released and recorded. */
  replay?: SessionReplay;
  error?: string;
  /** Wall-clock ms for the whole run, set on completion. */
  durationMs?: number;
}

/** Payload shape pushed over SSE. */
export type StatusPayload =
  | { type: "event"; event: AgentEvent }
  | { type: "state"; status: RunStatus; url: string }
  | { type: "replay"; replay: SessionReplay }
  | { type: "done"; report: Teardown; durationMs: number }
  | { type: "error"; error: string };
