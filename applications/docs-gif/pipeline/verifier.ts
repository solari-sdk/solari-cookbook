import { readFile } from "node:fs/promises";
import { z } from "zod";
import { answer } from "./model.ts";

const Verdict = z.object({
  ok: z.boolean().describe("true if the screen shows the end state"),
  reason: z.string().describe("one short reason"),
});

// Shows the model the first and last frame, so a goal phrased as a change ("a row appears") is checkable. Returns the reason so a retry can learn from it.
export async function verify(goal: string, before: string, after: string) {
  return answer(Verdict, [
    {
      role: "user",
      content: [
        { type: "file", mediaType: "image/png", data: await readFile(before) },
        { type: "file", mediaType: "image/png", data: await readFile(after) },
        { type: "text", text: `Two screenshots from a recording: the screen before it started, then the final screen. Comparing them, does the final screen show this end state? "${goal}"` },
      ],
    },
  ]);
}
