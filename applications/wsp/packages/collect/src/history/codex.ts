// SPDX-License-Identifier: AGPL-3.0-only
// Codex keeps one rollout jsonl per thread under sessions/YYYY/MM/DD/. A
// response_item line whose payload is a function_call is a call: exec_command
// (and the older shell) carry the command in a JSON string of arguments.
import type { Host } from "../host.js";
import { type Call, type HistoryReader, isRecord, jsonlFiles, stem, tryJson } from "./reader.js";

const SHELLS = new Set(["exec_command", "shell", "container.exec", "local_shell"]);

export function codexCall(session: string, name: string, args: unknown, folder?: string): Call {
  const arg = isRecord(args) ? args : {};
  const where = folder !== undefined ? { folder } : {};
  if (SHELLS.has(name)) {
    const cmd = arg["cmd"] ?? arg["command"];
    if (typeof cmd === "string") return { session, ...where, kind: "shell", line: cmd };
    if (Array.isArray(cmd) && cmd.every(w => typeof w === "string")) return { session, ...where, kind: "shell", line: cmd.join(" ") };
  }
  return { session, ...where, kind: "other", name };
}

export const codexReader: HistoryReader = {
  files: (host, root) => jsonlFiles(host, root, stem),
  async *read(host: Host, _root: string, file: string): AsyncIterable<Call> {
    const session = stem(file);
    // The rollout opens with a session_meta whose payload names the folder; every call after it is that folder's.
    let folder: string | undefined;
    for await (const line of host.fs.lines(file)) {
      if (folder === undefined && line.includes('"session_meta"')) {
        const meta = tryJson(line);
        const payload = isRecord(meta) && isRecord(meta["payload"]) ? meta["payload"] : undefined;
        if (payload !== undefined && typeof payload["cwd"] === "string") folder = payload["cwd"];
      }
      if (!line.includes('"function_call"')) continue;
      const row = tryJson(line);
      if (!isRecord(row) || row["type"] !== "response_item" || !isRecord(row["payload"])) continue;
      const payload = row["payload"];
      if (payload["type"] !== "function_call" || typeof payload["name"] !== "string") continue;
      const args = typeof payload["arguments"] === "string" ? tryJson(payload["arguments"]) : payload["arguments"];
      yield codexCall(session, payload["name"], args, folder);
    }
  },
};
