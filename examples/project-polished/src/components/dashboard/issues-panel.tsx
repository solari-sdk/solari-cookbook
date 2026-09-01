'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  ScanEye,
  AlertTriangle,
  Contrast,
  MousePointerClick,
  AlignHorizontalJustifyCenter,
  Smartphone,
  Accessibility,
  Loader2,
  Check,
  CircleDot,
} from 'lucide-react';
import { useAgentStore } from '@/store/agent-store';
import type { IssueSeverity, UxIssue } from '@/lib/agent-types';
import { cn } from '@/lib/utils';

const SEVERITY_STYLES: Record<IssueSeverity, { bg: string; border: string; text: string; label: string }> = {
  low: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300', label: 'LOW' },
  medium: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-300', label: 'MED' },
  high: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-300', label: 'HIGH' },
  critical: { bg: 'bg-rose-500/10', border: 'border-rose-500/30', text: 'text-rose-300', label: 'CRIT' },
};

const CATEGORY_ICON = {
  layout: AlignHorizontalJustifyCenter,
  contrast: Contrast,
  interaction: MousePointerClick,
  responsive: Smartphone,
  a11y: Accessibility,
} as const;

function IssueRow({ issue }: { issue: UxIssue }) {
  const Icon = CATEGORY_ICON[issue.category] ?? AlertTriangle;
  const sev = SEVERITY_STYLES[issue.severity];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: 'spring', stiffness: 200, damping: 25 }}
      className={cn(
        'rounded-xl border bg-card/60 p-3 transition-colors',
        issue.status === 'fixed' && 'border-emerald-500/40',
        issue.status === 'fixing' && 'border-amber-500/40',
        issue.status === 'detected' && sev.border,
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', sev.bg, sev.text)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={cn('text-[9px] font-mono font-bold px-1.5 py-0.5 rounded', sev.bg, sev.text)}>
              {sev.label}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
              {issue.category}
            </span>
            <div className="ml-auto">
              {issue.status === 'detected' && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <CircleDot className="h-3 w-3" />
                  detected
                </span>
              )}
              {issue.status === 'fixing' && (
                <span className="flex items-center gap-1 text-[10px] text-amber-300">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  fixing
                </span>
              )}
              {issue.status === 'fixed' && (
                <span className="flex items-center gap-1 text-[10px] text-emerald-300">
                  <Check className="h-3 w-3" />
                  fixed
                </span>
              )}
            </div>
          </div>
          <h4 className="text-xs font-medium leading-snug">{issue.title}</h4>
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{issue.description}</p>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono text-muted-foreground/80">
            <span className="truncate">{issue.filePath}:{issue.lineNumber}</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function IssuesPanel() {
  const issues = useAgentStore((s) => s.issues);
  const status = useAgentStore((s) => s.status);

  const detected = issues.filter((i) => i.status === 'detected').length;
  const fixing = issues.filter((i) => i.status === 'fixing').length;
  const fixed = issues.filter((i) => i.status === 'fixed').length;

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <ScanEye className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">Detected UX Issues</h2>
        </div>
        {issues.length > 0 && (
          <div className="flex items-center gap-2 text-[10px] font-mono">
            {detected > 0 && <span className="text-muted-foreground">{detected} detected</span>}
            {fixing > 0 && <span className="text-amber-300">{fixing} fixing</span>}
            {fixed > 0 && <span className="text-emerald-300">{fixed} fixed</span>}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 max-h-[420px] min-h-[200px]">
        {issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <ScanEye className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-xs">
              {status === 'running' ? 'Scanning captures...' : 'Issues will appear here'}
            </p>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              Vision model audits each screenshot for UX defects
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
