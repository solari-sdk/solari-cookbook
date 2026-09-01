'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  GitBranch,
  Terminal,
  Globe,
  ScanEye,
  Code2,
  GitPullRequest,
  Check,
  Loader2,
  Circle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAgentStore } from '@/store/agent-store';
import type { Stage } from '@/lib/agent-types';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  GitBranch,
  Terminal,
  Globe,
  ScanEye,
  Code2,
  GitPullRequest,
};

function StageRow({ stage, index, total }: { stage: Stage; index: number; total: number }) {
  const Icon = ICONS[stage.icon] ?? Circle;
  const isLast = index === total - 1;
  const isActive = stage.status === 'active';
  const isDone = stage.status === 'completed';

  return (
    <div className="relative flex gap-3 sm:gap-4 pb-6 last:pb-0">
      {/* Connector line */}
      {!isLast && (
        <div className="absolute left-[18px] top-9 bottom-0 w-px bg-border/60">
          <motion.div
            className="absolute top-0 left-0 right-0 bg-emerald-500"
            initial={{ height: 0 }}
            animate={{ height: isDone ? '100%' : isActive ? '50%' : '0%' }}
            transition={{ duration: 0.5 }}
          />
        </div>
      )}

      {/* Icon */}
      <div
        className={cn(
          'relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-300',
          isDone && 'border-emerald-500 bg-emerald-500 text-emerald-950',
          isActive && 'border-emerald-500 bg-emerald-500/10 text-emerald-400',
          !isDone && !isActive && 'border-border bg-background text-muted-foreground',
        )}
      >
        <AnimatePresence mode="wait">
          {isDone ? (
            <motion.div
              key="done"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
            >
              <Check className="h-4 w-4" strokeWidth={3} />
            </motion.div>
          ) : isActive ? (
            <motion.div
              key="active"
              initial={{ scale: 0.6 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.6 }}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ scale: 0.8 }} animate={{ scale: 1 }}>
              <Icon className="h-4 w-4" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Pulse ring when active */}
        {isActive && (
          <motion.div
            className="absolute inset-0 rounded-full border-2 border-emerald-500"
            animate={{ scale: [1, 1.4], opacity: [0.6, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0 pt-1">
        <div className="flex items-center justify-between gap-2">
          <h3
            className={cn(
              'text-sm font-medium transition-colors',
              isDone && 'text-foreground',
              isActive && 'text-emerald-400',
              !isDone && !isActive && 'text-muted-foreground',
            )}
          >
            {stage.label}
          </h3>
          {stage.progress > 0 && stage.progress < 100 && (
            <span className="text-[10px] font-mono text-muted-foreground">
              {stage.progress}%
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-snug">
          {stage.description}
        </p>
        {isActive && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: '100%' }}
            className="mt-2 h-0.5 bg-muted rounded-full overflow-hidden"
          >
            <motion.div
              className="h-full bg-emerald-500"
              animate={{ width: `${stage.progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </motion.div>
        )}
      </div>
    </div>
  );
}

export function PipelineTracker() {
  const stages = useAgentStore((s) => s.stages);
  const status = useAgentStore((s) => s.status);

  const completedCount = stages.filter((s) => s.status === 'completed').length;
  const overallProgress = Math.round(
    (stages.reduce((acc, s) => acc + s.progress, 0) / (stages.length * 100)) * 100,
  );

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur p-5 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Agent Pipeline</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            6-stage Solari workflow · {completedCount}/{stages.length} complete
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums leading-none">{overallProgress}%</div>
          <div className="text-[10px] text-muted-foreground mt-1 uppercase tracking-wider">
            {status === 'idle' && 'Idle'}
            {status === 'running' && 'Running'}
            {status === 'completed' && 'Done'}
            {status === 'failed' && 'Failed'}
          </div>
        </div>
      </div>

      <div className="mt-4">
        {stages.map((stage, idx) => (
          <StageRow
            key={stage.id}
            stage={stage}
            index={idx}
            total={stages.length}
          />
        ))}
      </div>
    </div>
  );
}
