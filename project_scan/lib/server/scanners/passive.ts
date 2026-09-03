import type { Finding, Severity } from "@/lib/types";
import type { ExecResult } from "@/lib/server/solari-sandbox";
import { findingId } from "@/lib/server/finding-id";

function finding(
  partial: Omit<Finding, "id" | "source"> & { id?: string },
): Finding {
  const seed = `${partial.url ?? ""}:${partial.title}:${partial.detail}`;
  return { ...partial, id: partial.id ?? findingId("passive", seed), source: "passive" };
}

const HEADER_CHECKS: { header: string; severity: Severity; title: string; remediation: string }[] = [
  {
    header: "strict-transport-security",
    severity: "high",
    title: "Missing HSTS header",
    remediation: "Add Strict-Transport-Security with max-age >= 31536000",
  },
  {
    header: "content-security-policy",
    severity: "medium",
    title: "Missing Content-Security-Policy",
    remediation: "Define a CSP to restrict script and resource origins",
  },
  {
    header: "x-frame-options",
    severity: "medium",
    title: "Missing X-Frame-Options",
    remediation: "Set X-Frame-Options: DENY or SAMEORIGIN, or use frame-ancestors in CSP",
  },
  {
    header: "x-content-type-options",
    severity: "low",
    title: "Missing X-Content-Type-Options",
    remediation: "Set X-Content-Type-Options: nosniff",
  },
  {
    header: "referrer-policy",
    severity: "low",
    title: "Missing Referrer-Policy",
    remediation: "Set Referrer-Policy: strict-origin-when-cross-origin or stricter",
  },
];

export function parseHeaders(targetUrl: string, curlOut: ExecResult): Finding[] {
  const findings: Finding[] = [];
  if (curlOut.exitCode !== 0) {
    findings.push(
      finding({
        severity: "high",
        category: "headers",
        title: "Could not fetch response headers",
        detail: curlOut.stderr.trim() || "curl failed",
        url: targetUrl,
        remediation: "Ensure the URL is reachable over the network",
      }),
    );
    return findings;
  }

  const headers = new Map<string, string>();
  for (const line of curlOut.stdout.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }

  if (targetUrl.startsWith("https://") && !headers.has("strict-transport-security")) {
    findings.push(
      finding({
        severity: "high",
        category: "headers",
        title: "Missing HSTS on HTTPS site",
        detail: "No Strict-Transport-Security response header",
        url: targetUrl,
        remediation: "Add HSTS before production",
      }),
    );
  }

  for (const check of HEADER_CHECKS) {
    if (!headers.has(check.header)) {
      findings.push(
        finding({
          severity: check.severity,
          category: "headers",
          title: check.title,
          detail: `Response missing ${check.header}`,
          url: targetUrl,
          remediation: check.remediation,
        }),
      );
    }
  }

  const location = headers.get("location");
  if (location && location.startsWith("http://")) {
    findings.push(
      finding({
        severity: "medium",
        category: "misconfig",
        title: "Redirect to insecure HTTP",
        detail: `Location header points to ${location}`,
        evidence: location,
        url: targetUrl,
        remediation: "Redirect to HTTPS only",
      }),
    );
  }

  return findings;
}

export function parseTls(targetUrl: string, opensslOut: ExecResult): Finding[] {
  if (!targetUrl.startsWith("https://")) return [];
  const findings: Finding[] = [];
  const out = `${opensslOut.stdout}\n${opensslOut.stderr}`;

  if (/verify error|certificate has expired|self signed/i.test(out)) {
    findings.push(
      finding({
        severity: "critical",
        category: "tls",
        title: "TLS certificate problem",
        detail: out.split("\n").find((l) => /error|expired|self signed/i.test(l)) ?? "Certificate issue detected",
        url: targetUrl,
        remediation: "Fix or renew the TLS certificate before production",
        evidence: out.slice(0, 500),
      }),
    );
  }

  if (/TLSv1\.0|TLSv1\.1|SSLv3/i.test(out)) {
    findings.push(
      finding({
        severity: "high",
        category: "tls",
        title: "Outdated TLS protocol negotiated",
        detail: "Server supports deprecated TLS versions",
        url: targetUrl,
        remediation: "Disable TLS 1.0/1.1 and require TLS 1.2+",
      }),
    );
  }

  return findings;
}

export async function runPassiveScans(
  sandboxId: string,
  targetUrl: string,
  execFn: (cmd: string, args: string[]) => Promise<ExecResult>,
): Promise<Finding[]> {
  const host = new URL(targetUrl).hostname;
  const port = new URL(targetUrl).port || (targetUrl.startsWith("https") ? "443" : "80");

  const [curl, tls] = await Promise.all([
    execFn("curl", ["-sI", "-L", "--max-time", "20", targetUrl]),
    targetUrl.startsWith("https://")
      ? execFn("sh", [
          "-c",
          `echo | openssl s_client -connect ${host}:${port} -servername ${host} 2>&1 | head -80`,
        ])
      : Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  ]);

  return [...parseHeaders(targetUrl, curl), ...parseTls(targetUrl, tls)];
}
