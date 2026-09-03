import type { Finding, ScanReport, Verdict } from "@/lib/types";
import { env, openRouterKey } from "./env";

const MODEL = env("OPENROUTER_MODEL", "z-ai/glm-5.3-flash");
const MAX_TURNS = 50;
const TOOL_OUTPUT_LIMIT = 40_000;

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "warn", "fail"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    priorityFixes: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          category: {
            type: "string",
            enum: ["tls", "headers", "cookies", "exposure", "misconfig", "injection"],
          },
          title: { type: "string" },
          detail: { type: "string" },
          evidence: { type: "string" },
          url: { type: "string" },
          remediation: { type: "string" },
          source: { type: "string", enum: ["passive", "crawl", "nuclei", "agent"] },
        },
        required: ["severity", "category", "title", "detail", "remediation"],
      },
    },
  },
  required: ["verdict", "confidence", "summary", "priorityFixes", "findings"],
} as const;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the Solari sandbox to investigate findings.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["cmd", "args"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate the Solari browser to a URL on the target site.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_read_page",
      description: "Read the current browser page title, URL, and visible text.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_evaluate",
      description: "Run JavaScript in the current page context and return the result as JSON.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_report",
      description: "Submit the final security report. Call exactly once when done.",
      parameters: REPORT_SCHEMA,
    },
  },
];

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

function truncate(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text;
  return `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n... [truncated]`;
}

async function streamTurn(
  key: string,
  messages: Message[],
  onReasoning: (delta: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      include_reasoning: true,
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenRouter request failed (${res.status}): ${await res.text()}`);
  }

  let content = "";
  const toolCalls: ToolCall[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return { content, toolCalls };
      try {
        const chunk = JSON.parse(data) as {
          choices?: {
            delta?: {
              content?: string;
              reasoning?: string;
              tool_calls?: {
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[];
        };
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.reasoning) onReasoning(delta.reasoning);
        if (delta?.content) content += delta.content;
        for (const tc of delta?.tool_calls ?? []) {
          const slot = (toolCalls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      } catch {
        // partial chunk
      }
    }
  }
  return { content, toolCalls };
}

const SYSTEM_PROMPT = `You are a senior application security engineer reviewing a staging site before production launch.

You receive automated scan findings from passive checks, a browser crawl, and nuclei. Your job:
1. Investigate high-severity and suspicious findings using tools
2. Confirm or downgrade false positives with evidence
3. Add any new findings you discover with source "agent"
4. Call submit_report exactly once with verdict pass/warn/fail

Verdict rules:
- fail: confirmed critical/high issues (exposed secrets, broken TLS, serious misconfig)
- warn: medium/low issues or unconfirmed suspicious patterns
- pass: no meaningful issues after review

Be concise. Do not ask questions — use your tools.`;

export function deterministicReport(findings: Finding[]): ScanReport {
  const hasCritical = findings.some((f) => f.severity === "critical" || f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");
  const verdict: Verdict = hasCritical ? "fail" : hasMedium ? "warn" : "pass";
  const priorityFixes = findings
    .filter((f) => ["critical", "high", "medium"].includes(f.severity))
    .slice(0, 8)
    .map((f) => f.remediation);
  return {
    verdict,
    confidence: hasCritical ? 85 : hasMedium ? 70 : 90,
    summary:
      findings.length === 0
        ? "No security issues detected by automated scanners."
        : `Found ${findings.length} issue(s). Highest severity: ${findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]?.severity ?? "none"}.`,
    priorityFixes,
    findings,
  };
}

function severityRank(s: Finding["severity"]): number {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s];
}

export async function runAgent(params: {
  targetUrl: string;
  rawFindings: Finding[];
  pagesVisited: string[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onReasoning: (delta: string) => void;
  onTool: (name: string, detail: string, done: boolean) => void;
}): Promise<ScanReport> {
  const key = openRouterKey();
  if (!key) return deterministicReport(params.rawFindings);

  const initial = `Target: ${params.targetUrl}
Pages crawled (${params.pagesVisited.length}): ${params.pagesVisited.slice(0, 20).join(", ")}

Raw findings (${params.rawFindings.length}):
${JSON.stringify(params.rawFindings, null, 2)}`;

  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: initial },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await streamTurn(key, messages, params.onReasoning);

    if (result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: result.content || null });
      messages.push({ role: "user", content: "Call submit_report now with your final assessment." });
      continue;
    }

    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    for (const tc of result.toolCalls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.args || "{}") as Record<string, unknown>;
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "error: invalid JSON arguments",
        });
        continue;
      }

      if (tc.name === "submit_report") {
        const report = args as unknown as ScanReport;
        report.findings = (report.findings ?? []).map((f, i) => ({
          ...f,
          id: f.id ?? `agent-${i}`,
          source: f.source ?? "agent",
        }));
        params.onTool("submit_report", `${report.verdict} (${report.confidence}%)`, true);
        return report;
      }

      const detail =
        tc.name === "run_command"
          ? `$ ${String(args.cmd)} ${((args.args as string[]) ?? []).join(" ")}`
          : tc.name === "browser_navigate"
            ? String(args.url)
            : tc.name === "browser_evaluate"
              ? String(args.expression).slice(0, 80)
              : tc.name;
      params.onTool(tc.name, detail, false);
      const output = truncate(await params.executeTool(tc.name, args));
      params.onTool(tc.name, `${detail} → ${output.split("\n")[0]?.slice(0, 100) ?? "done"}`, true);
      messages.push({ role: "tool", tool_call_id: tc.id, content: output });
    }
  }

  return deterministicReport(params.rawFindings);
}
