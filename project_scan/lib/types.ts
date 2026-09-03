export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Verdict = "pass" | "warn" | "fail";
export type FindingSource = "passive" | "crawl" | "nuclei" | "agent";

export interface Finding {
  id: string;
  severity: Severity;
  category: "tls" | "headers" | "cookies" | "exposure" | "misconfig" | "injection";
  title: string;
  detail: string;
  evidence?: string;
  url?: string;
  remediation: string;
  source: FindingSource;
}

export interface ScanReport {
  verdict: Verdict;
  confidence: number;
  summary: string;
  priorityFixes: string[];
  findings: Finding[];
}

export interface StoredScan {
  id: string;
  url: string;
  hostname: string;
  verdict: Verdict;
  confidence: number;
  summary: string;
  priorityFixes: string[];
  findings: Finding[];
  replayUrl?: string | null;
  durationMs: number;
  createdAt: string;
}

export type ScanStep = "validate" | "passive" | "crawl" | "collect" | "agent" | "done";

export type ScanEvent =
  | { type: "status"; step: ScanStep; message?: string }
  | { type: "log"; message: string }
  | { type: "finding"; finding: Finding }
  | { type: "reasoning"; delta: string }
  | { type: "tool"; name: string; detail: string; done: boolean }
  | { type: "done"; scanId: string; payload: StoredScan };
