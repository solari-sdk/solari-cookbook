import { setTimeout as sleep } from "node:timers/promises";
import { generateText, tool, type ModelMessage } from "ai";
import type { z } from "zod";

let last = 0;

export async function answer<T extends z.ZodType>(schema: T, prompt: string | ModelMessage[]): Promise<z.infer<T>> {
  await sleep(Math.max(0, last + 12_000 - Date.now()));
  last = Date.now();
  const { staticToolCalls, toolCalls } = await generateText({
    model: "openai/gpt-4.1-mini",
    tools: { answer: tool({ inputSchema: schema }) },
    toolChoice: { type: "tool", toolName: "answer" },
    prompt,
  });
  const call = staticToolCalls[0];
  if (!call) throw new Error(`no valid answer came back: ${JSON.stringify(toolCalls)}`);
  return call.input as z.infer<T>;
}
