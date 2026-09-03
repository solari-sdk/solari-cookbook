import type { Finding, Severity } from "@/lib/types";
import type { ExecResult } from "@/lib/server/solari-sandbox";
import { findingId } from "@/lib/server/finding-id";

const SEVERITY_MAP: Record<string, Severity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  info: "info",
  unknown: "info",
};

export async function ensureNuclei(
  execFn: (cmd: string, args: string[]) => Promise<ExecResult>,
): Promise<void> {
  const check = await execFn("sh", ["-c", "command -v nuclei || test -x /tmp/nuclei"]);
  if (check.exitCode === 0) return;

  await execFn("sh", [
    "-c",
    `curl -sL https://github.com/projectdiscovery/nuclei/releases/download/v3.3.7/nuclei_3.3.7_linux_amd64.zip -o /tmp/nuclei.zip \
     && unzip -o /tmp/nuclei.zip nuclei -d /tmp \
     && chmod +x /tmp/nuclei`,
  ]);
}

export function parseNucleiOutput(targetUrl: string, stdout: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        info?: { name?: string; severity?: string; description?: string };
        "template-id"?: string;
        host?: string;
        matched?: string;
      };
      const info = row.info ?? {};
      const severity = SEVERITY_MAP[(info.severity ?? "info").toLowerCase()] ?? "info";
      findings.push({
        id: findingId("nuclei", `${row.host ?? targetUrl}:${row["template-id"]}:${info.name}:${row.matched ?? ""}`),
        severity,
        category: "misconfig",
        title: info.name ?? row["template-id"] ?? "Nuclei finding",
        detail: info.description ?? "Detected by nuclei template scan",
        evidence: row.matched,
        url: row.host ?? targetUrl,
        remediation: "Review nuclei template guidance and fix the underlying misconfiguration",
        source: "nuclei",
      });
    } catch {
      // non-JSON line
    }
  }
  return findings;
}

export async function runNucleiScan(
  targetUrl: string,
  execFn: (cmd: string, args: string[]) => Promise<ExecResult>,
): Promise<Finding[]> {
  await ensureNuclei(execFn);
  const res = await execFn("sh", [
    "-c",
    `/tmp/nuclei -u ${JSON.stringify(targetUrl)} -tags safe,headers,ssl,misconfig -jsonl -silent -timeout 10 -rate-limit 20 2>/dev/null || true`,
  ]);
  return parseNucleiOutput(targetUrl, res.stdout);
}
