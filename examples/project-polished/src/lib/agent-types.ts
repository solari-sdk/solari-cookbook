// ============================================================================
// Project Polished — Agent Type Definitions
// Autonomous UI/UX Revamp Agent powered by Solari SDK
// ============================================================================

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export type StageId =
  | 'sandbox_clone'
  | 'sandbox_run'
  | 'browser_drive'
  | 'vision_analyze'
  | 'desktop_fix'
  | 'verify_pr';

export interface Stage {
  id: StageId;
  label: string;
  description: string;
  icon: string; // lucide icon name
  status: 'pending' | 'active' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  progress: number; // 0 - 100
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug' | 'command';

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  stage: StageId;
  message: string;
  meta?: Record<string, unknown>;
}

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface UxIssue {
  id: string;
  title: string;
  severity: IssueSeverity;
  category: 'layout' | 'contrast' | 'interaction' | 'responsive' | 'a11y';
  description: string;
  filePath: string;
  lineNumber: number;
  // coordinates on the simulated screenshot canvas (0-100 percent)
  bbox: { x: number; y: number; w: number; h: number };
  suggestedFix: string;
  status: 'detected' | 'fixing' | 'fixed';
}

export interface Screenshot {
  id: string;
  page: string;
  url: string;
  capturedAt: number;
  width: number;
  height: number;
  // pre-rendered HTML snapshot key (used by the simulated browser preview)
  snapshotKey: 'home' | 'pricing' | 'features' | 'footer';
}

export interface CodeDiff {
  id: string;
  issueId: string;
  filePath: string;
  before: string;
  after: string;
  language: string;
  appliedAt?: number;
}

export interface PullRequest {
  number: number;
  title: string;
  branch: string;
  base: string;
  url: string;
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  body: string;
}

export interface AgentRunSummary {
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  startedAt: number;
  completedAt?: number;
  totalIssuesFound: number;
  totalIssuesFixed: number;
  screenshotsCaptured: number;
  filesModified: number;
  buildSucceeded: boolean;
  pullRequest?: PullRequest;
}
