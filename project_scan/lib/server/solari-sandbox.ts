import { requireSolariKey } from "./env";

const BASE_URL = "https://api.getsolari.com";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function createSandbox(): Promise<string> {
  const res = await fetch(`${BASE_URL}/sandboxes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireSolariKey()}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      template: "base",
      cpu: 2,
      memMb: 4096,
      timeoutMs: 900_000,
      lifecycle: { onTimeout: "kill" },
    }),
  });
  if (!res.ok) throw new Error(`Solari sandbox create failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { sandboxId: string };
  return body.sandboxId;
}

export async function exec(sandboxId: string, cmd: string, args: string[]): Promise<ExecResult> {
  const res = await fetch(`${BASE_URL}/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireSolariKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cmd, args }),
  });
  if (!res.ok) throw new Error(`Solari exec "${cmd}" failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as ExecResult;
}

export async function killSandbox(sandboxId: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/sandboxes/${encodeURIComponent(sandboxId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${requireSolariKey()}` },
    });
  } catch {
    // best effort
  }
}
