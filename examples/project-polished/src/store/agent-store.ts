// ============================================================================
// Project Polished — Agent State (Zustand)
// Single source of truth for the dashboard UI.
// ============================================================================

'use client';

import { create } from 'zustand';
import type {
  AgentRunSummary,
  AgentStatus,
  CodeDiff,
  LogEntry,
  PullRequest,
  Screenshot,
  Stage,
  StageId,
  UxIssue,
} from '@/lib/agent-types';

const STAGES_INITIAL: Stage[] = [
  {
    id: 'sandbox_clone',
    label: 'Sandbox Clone',
    description: 'Fork target repo into isolated Solari sandbox',
    icon: 'GitBranch',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'sandbox_run',
    label: 'Dev Server',
    description: 'npm install + boot dev server inside sandbox',
    icon: 'Terminal',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'browser_drive',
    label: 'Browser Drive',
    description: 'Solari browser agent crawls routes, captures screenshots',
    icon: 'Globe',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'vision_analyze',
    label: 'Vision Analyze',
    description: 'AI vision model audits captures for UX defects',
    icon: 'ScanEye',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'desktop_fix',
    label: 'Desktop Fix',
    description: 'Solari desktop agent opens VS Code, writes patches',
    icon: 'Code2',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'verify_pr',
    label: 'Verify + PR',
    description: 'Re-capture, build, push branch, open pull request',
    icon: 'GitPullRequest',
    status: 'pending',
    progress: 0,
  },
];

export interface AgentState {
  status: AgentStatus;
  repoUrl: string;
  stages: Stage[];
  logs: LogEntry[];
  issues: UxIssue[];
  screenshots: Screenshot[];
  diffs: CodeDiff[];
  summary: AgentRunSummary | null;
  pullRequest: PullRequest | null;
  activeScreenshotId: string | null;

  // actions
  setRepoUrl: (url: string) => void;
  startRun: () => void;
  reset: () => void;
  pushLog: (entry: Omit<LogEntry, 'id' | 'ts'>) => void;
  updateStage: (id: StageId, patch: Partial<Stage>) => void;
  setActiveStage: (id: StageId) => void;
  addScreenshot: (s: Screenshot) => void;
  setActiveScreenshot: (id: string | null) => void;
  addIssue: (issue: UxIssue) => void;
  updateIssue: (id: string, patch: Partial<UxIssue>) => void;
  addDiff: (diff: CodeDiff) => void;
  setPullRequest: (pr: PullRequest) => void;
  setSummary: (s: AgentRunSummary) => void;
  setStatus: (s: AgentStatus) => void;
}

let logCounter = 0;

export const useAgentStore = create<AgentState>((set) => ({
  status: 'idle',
  repoUrl: '',
  stages: STAGES_INITIAL.map((s) => ({ ...s })),
  logs: [],
  issues: [],
  screenshots: [],
  diffs: [],
  summary: null,
  pullRequest: null,
  activeScreenshotId: null,

  setRepoUrl: (url) => set({ repoUrl: url }),

  startRun: () =>
    set({
      status: 'running',
      stages: STAGES_INITIAL.map((s) => ({ ...s })),
      logs: [],
      issues: [],
      screenshots: [],
      diffs: [],
      summary: null,
      pullRequest: null,
      activeScreenshotId: null,
    }),

  reset: () =>
    set({
      status: 'idle',
      stages: STAGES_INITIAL.map((s) => ({ ...s })),
      logs: [],
      issues: [],
      screenshots: [],
      diffs: [],
      summary: null,
      pullRequest: null,
      activeScreenshotId: null,
    }),

  pushLog: (entry) =>
    set((state) => ({
      logs: [
        ...state.logs,
        {
          ...entry,
          id: `log-${logCounter++}`,
          ts: Date.now(),
        },
      ].slice(-200),
    })),

  updateStage: (id, patch) =>
    set((state) => ({
      stages: state.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    })),

  setActiveStage: (id) =>
    set((state) => ({
      stages: state.stages.map((s) =>
        s.id === id && s.status === 'pending'
          ? { ...s, status: 'active', startedAt: Date.now() }
          : s,
      ),
    })),

  addScreenshot: (s) =>
    set((state) => ({
      screenshots: [...state.screenshots, s],
      activeScreenshotId: s.id,
    })),

  setActiveScreenshot: (id) => set({ activeScreenshotId: id }),

  addIssue: (issue) =>
    set((state) => ({
      issues: [...state.issues, issue],
    })),

  updateIssue: (id, patch) =>
    set((state) => ({
      issues: state.issues.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    })),

  addDiff: (diff) =>
    set((state) => ({
      diffs: [...state.diffs, diff],
    })),

  setPullRequest: (pr) => set({ pullRequest: pr }),

  setSummary: (s) => set({ summary: s }),

  setStatus: (s) => set({ status: s }),
}));
