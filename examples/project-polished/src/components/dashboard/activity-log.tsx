'use client';

import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal } from 'lucide-react';
import { useAgentStore } from '@/store/agent-store';
import type { LogLevel } from '@/lib/agent-types';
import { cn } from '@/lib/utils';

const LEVEL_STYLES: Record<LogLevel, { dot: string; text: string; label: string }> = {
  info: { dot: 'bg-sky-400', text: 'text-sky-300', label: 'INFO' },
  success: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'OK' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-300', label: 'WARN' },
  error: { dot: 'bg-rose-400', text: 'text-rose-300', label: 'ERR' },
  debug: { dot: 'bg-zinc-400', text: 'text-zinc-400', label: 'DBG' },
  command: { dot: 'bg-violet-400', text: 'text-violet-300', label: '$' },
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function ActivityLog() {
  const logs = useAgentStore((s) => s.logs);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">Agent Activity Log</h2>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">
          {logs.length} events
        </span>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-3 font-mono text-[11.5px] leading-relaxed min-h-[280px] max-h-[420px]"
        style={{
          scrollbarWidth: 'thin',
        }}
      >
        {logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <Terminal className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-xs">Agent logs will stream here when you press Run.</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {logs.map((entry) => {
              const style = LEVEL_STYLES[entry.level];
              return (
                <motion.div
                  key={entry.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-start gap-2 px-2 py-0.5 rounded hover:bg-muted/40 group"
                >
                  <span className="text-muted-foreground/60 select-none shrink-0 tabular-nums">
                    {fmtTime(entry.ts)}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center justify-center w-8 shrink-0 text-[10px] uppercase font-bold tracking-wide',
                      style.text,
                    )}
                  >
                    {style.label}
                  </span>
                  <span className="text-muted-foreground/60 select-none shrink-0">
                    [{entry.stage.replace('_', ' ')}]
                  </span>
                  <span
                    className={cn(
                      'break-all whitespace-pre-wrap',
                      entry.level === 'command' ? 'text-violet-200' : 'text-foreground/90',
                    )}
                  >
                    {entry.message}
                  </span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
