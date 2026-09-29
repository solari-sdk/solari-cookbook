/**
 * A minimal Claude tool-use loop: send messages, run whichever tools the
 * model calls, feed the results back, repeat until it calls `stopTool` (or
 * stops calling tools at all, which the caller treats as a failed run).
 *
 * Both agents in this example share this loop — only their tool list, system
 * prompt, and tool handler differ.
 */
import Anthropic from "@anthropic-ai/sdk"

export type ToolDef = {
  name: string
  description: string
  input_schema: Anthropic.Tool["input_schema"]
}

export async function runToolLoop(opts: {
  anthropic: Anthropic
  system: string
  userMessage: string
  tools: ToolDef[]
  stopTool: string
  handleTool: (name: string, input: any) => Promise<string>
  model?: string
  maxTurns?: number
}): Promise<void> {
  const model = opts.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-5"
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.userMessage }]

  for (let turn = 0; turn < (opts.maxTurns ?? 20); turn++) {
    const response = await opts.anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: opts.system,
      tools: opts.tools,
      messages,
    })

    messages.push({ role: "assistant", content: response.content })

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    )
    // The model stopped without calling the terminal tool — the caller
    // decides what a missing verdict means for its own flow.
    if (toolUses.length === 0) return

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const use of toolUses) {
      const content = await opts.handleTool(use.name, use.input as any)
      toolResults.push({ type: "tool_result", tool_use_id: use.id, content })
      if (use.name === opts.stopTool) return
    }
    messages.push({ role: "user", content: toolResults })
  }
}
