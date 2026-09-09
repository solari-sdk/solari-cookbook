/**
 * Turn a page's visible text into a structured status, via a single
 * tool-forced Claude call rather than a CSS selector.
 *
 * Every ATS lays its status page out differently (Greenhouse, Lever, Ashby,
 * a homegrown Workday instance...) — a selector that works for one breaks on
 * the next. Reading the rendered text and asking a model to extract the
 * status generalizes across all of them with zero per-site code.
 */
import Anthropic from "@anthropic-ai/sdk"
import type { PortalStatus } from "./types.js"

export async function extractStatus(anthropic: Anthropic, pageText: string): Promise<PortalStatus> {
  const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-5"

  const response = await anthropic.messages.create({
    model,
    max_tokens: 300,
    // Forcing the one tool guarantees structured JSON back — no prose to
    // parse, no "sure, here's the status:" preamble to strip.
    tool_choice: { type: "tool", name: "record_status" },
    tools: [
      {
        name: "record_status",
        description: "Record the applicant's current status as shown on this careers-portal page.",
        input_schema: {
          type: "object",
          properties: {
            stage: {
              type: "string",
              description: "Short stage label, e.g. 'Application received', 'Interview scheduled', 'Rejected', 'Offer'.",
            },
            detail: {
              type: "string",
              description: "Any specific detail worth surfacing (a date, an interviewer, next steps). Empty string if none.",
            },
          },
          required: ["stage", "detail"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Page text from a job/internship application portal:\n\n${pageText}\n\nExtract the applicant's current status.`,
      },
    ],
  })

  const use = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  )
  if (!use) throw new Error("model did not return a status")
  return use.input as PortalStatus
}
