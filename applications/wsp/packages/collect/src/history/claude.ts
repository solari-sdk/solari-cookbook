// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code keeps one jsonl per session under projects/<project key>/, with
// sub-agent transcripts nested in a directory of the session's id and cleared
// sessions moved under _cleared_sessions. An assistant line's tool_use blocks
// are the calls; Bash carries the shell line.
import type { Host } from "../host.js";
import { type Call, type HistoryReader, isRecord, jsonlFiles, stem, tryJson } from "./reader.js";

const CLEARED = "_cleared_sessions";

/** The top-level session a transcript belongs to, from its path under the projects root. */
export function claudeSession(rel: string): string | undefined {
  const parts = rel.split("/");
  const second = parts[1];
  if (second === undefined) return undefined;
  if (second === CLEARED) return parts[2] === undefined ? undefined : stem(parts[2]);
  return second.endsWith(".jsonl") ? stem(second) : second;
}

export function claudeCall(session: string, name: string, input: unknown, folder?: string): Call {
  const arg = isRecord(input) ? input : {};
  const where = folder !== undefined ? { folder } : {};
  if (name === "Bash" && typeof arg["command"] === "string") return { session, ...where, kind: "shell", line: arg["command"] };
  return { session, ...where, kind: "other", name };
}

export const claudeReader: HistoryReader = {
  files: (host, root) => jsonlFiles(host, root, file => claudeSession(file.slice(root.length + 1))),
  async *read(host: Host, root: string, file: string): AsyncIterable<Call> {
    const session = claudeSession(file.slice(root.length + 1));
    if (session === undefined) return;
    for await (const line of host.fs.lines(file)) {
      // Only an assistant line holds a tool_use block; the two checks keep the large tool-result lines unparsed.
      if (!line.includes('"tool_use"') || !line.includes('"assistant"')) continue;
      const row = tryJson(line);
      if (!isRecord(row) || row["type"] !== "assistant" || !isRecord(row["message"])) continue;
      const content = row["message"]["content"];
      if (!Array.isArray(content)) continue;
      // Every line of a transcript carries the folder the session ran in, this one included.
      const folder = typeof row["cwd"] === "string" ? row["cwd"] : undefined;
      for (const block of content) {
        if (!isRecord(block) || block["type"] !== "tool_use" || typeof block["name"] !== "string") continue;
        yield claudeCall(session, block["name"], block["input"], folder);
      }
    }
  },
};
