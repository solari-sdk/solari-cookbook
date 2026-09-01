'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  GitPullRequest,
  ExternalLink,
  GitCommit,
  FileEdit,
  Plus,
  Minus,
  Check,
  Sparkles,
} from 'lucide-react';
import { useAgentStore } from '@/store/agent-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function PrSummary() {
  const pr = useAgentStore((s) => s.pullRequest);
  const summary = useAgentStore((s) => s.summary);

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">Pull Request</h2>
        </div>
        {pr && (
          <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20">
            <Check className="h-3 w-3 mr-1" />
            Opened
          </Badge>
        )}
      </div>

      <AnimatePresence mode="wait">
        {pr ? (
          <motion.div
            key="pr"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-5"
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="h-9 w-9 shrink-0 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <GitPullRequest className="h-4 w-4 text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium leading-snug">{pr.title}</h3>
                <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground font-mono">
                  <span className="text-emerald-300">{pr.branch}</span>
                  <span>→</span>
                  <span>{pr.base}</span>
                </div>
              </div>
              <Button asChild size="sm" variant="outline" className="gap-1.5 shrink-0">
                <a href={pr.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3 w-3" />
                  View
                </a>
              </Button>
            </div>

            <div className="grid grid-cols-4 gap-2 text-center">
              <Stat
                icon={<GitCommit className="h-3.5 w-3.5" />}
                value={pr.commits}
                label="commits"
              />
              <Stat
                icon={<FileEdit className="h-3.5 w-3.5" />}
                value={pr.filesChanged}
                label="files"
              />
              <Stat
                icon={<Plus className="h-3.5 w-3.5" />}
                value={`+${pr.additions}`}
                label="add"
                className="text-emerald-300"
              />
              <Stat
                icon={<Minus className="h-3.5 w-3.5" />}
                value={`-${pr.deletions}`}
                label="del"
                className="text-rose-300"
              />
            </div>

            {summary && (
              <div className="mt-4 pt-4 border-t border-border/60 flex items-center gap-3 text-[11px] text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                <span>
                  Fixed <span className="text-emerald-300 font-medium">{summary.totalIssuesFixed}</span>{' '}
                  issues across <span className="text-emerald-300 font-medium">{summary.filesModified}</span>{' '}
                  files in <span className="text-emerald-300 font-medium">~60s</span>.
                </span>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="p-8 text-center"
          >
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted mb-2">
              <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xs text-muted-foreground">
              Agent will open a pull request here when fixes are verified.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
  className,
}: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/40 border border-border/40 px-2 py-2.5">
      <div className={`flex items-center justify-center gap-1 ${className ?? 'text-foreground'}`}>
        {icon}
        <span className="font-mono font-semibold tabular-nums text-sm">{value}</span>
      </div>
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}
