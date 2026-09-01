'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Code2, GitBranch, Check, FileCode2 } from 'lucide-react';
import { useAgentStore } from '@/store/agent-store';
import { cn } from '@/lib/utils';

function DiffBlock({ diff }: { diff: ReturnType<typeof useAgentStore.getState>['diffs'][number] }) {
  const beforeLines = diff.before.split('\n');
  const afterLines = diff.after.split('\n');

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: 'spring', stiffness: 200, damping: 25 }}
      className="rounded-xl border border-emerald-500/30 bg-card/60 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-emerald-500/5">
        <FileCode2 className="h-3.5 w-3.5 text-emerald-400" />
        <span className="font-mono text-[11px] text-foreground/90 truncate">{diff.filePath}</span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-300">
          <Check className="h-3 w-3" />
          applied
        </span>
      </div>
      <div className="font-mono text-[11px] leading-relaxed">
        {beforeLines.map((line, idx) => (
          <div key={`b-${idx}`} className="flex hover:bg-rose-500/5 px-3">
            <span className="select-none w-5 text-right pr-2 text-muted-foreground/40 text-[10px] shrink-0">
              {idx + 1}
            </span>
            <span className="text-rose-400/80 select-none pr-2 shrink-0">-</span>
            <span className="text-rose-200/70 whitespace-pre-wrap break-all">{line || ' '}</span>
          </div>
        ))}
        {afterLines.map((line, idx) => (
          <div key={`a-${idx}`} className="flex hover:bg-emerald-500/5 px-3 bg-emerald-500/5">
            <span className="select-none w-5 text-right pr-2 text-muted-foreground/40 text-[10px] shrink-0">
              {idx + 1}
            </span>
            <span className="text-emerald-400/80 select-none pr-2 shrink-0">+</span>
            <span className="text-emerald-200 whitespace-pre-wrap break-all">{line || ' '}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

export function DiffPanel() {
  const diffs = useAgentStore((s) => s.diffs);

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">Applied Patches</h2>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
          <GitBranch className="h-3 w-3" />
          {diffs.length} file{diffs.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 max-h-[420px] min-h-[200px]">
        {diffs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <Code2 className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-xs">Desktop agent will write patches here</p>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              Solari drives VS Code to apply surgical fixes
            </p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {diffs.map((diff) => (
              <DiffBlock key={diff.id} diff={diff} />
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
