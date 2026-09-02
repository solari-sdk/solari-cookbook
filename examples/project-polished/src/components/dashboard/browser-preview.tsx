'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  Globe,
  Camera,
  ChevronLeft,
  ChevronRight,
  ScanEye,
  Loader2,
  Wifi,
} from 'lucide-react';
import { useAgentStore } from '@/store/agent-store';
import type { IssueSeverity, Screenshot } from '@/lib/agent-types';
import { cn } from '@/lib/utils';

const SEVERITY_COLOR: Record<IssueSeverity, string> = {
  low: '#10b981',
  medium: '#f59e0b',
  high: '#fb923c',
  critical: '#ef4444',
};

function SnapshotContent({ snapshot }: { snapshot: Screenshot['snapshotKey'] }) {
  // A pure-CSS mock of what a typical SaaS marketing page looks like.
  // Drawn so the bbox overlays line up with the SAMPLE_ISSUES coordinates.

  if (snapshot === 'home') {
    return (
      <div className="w-full h-full bg-white text-zinc-800 font-sans flex flex-col">
        {/* nav */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded bg-emerald-500" />
            <span className="text-sm font-semibold">acme</span>
          </div>
          <div className="flex items-center gap-4 text-[10px] text-zinc-500">
            <span>Product</span>
            <span>Pricing</span>
            <span>Docs</span>
            <span className="rounded bg-zinc-900 text-white px-2 py-1">Get Started</span>
          </div>
        </div>
        {/* hero */}
        <div className="px-8 py-10 text-center relative">
          {/* The truncated headline (issue-4 bbox ~ y:18-32) */}
          <h1 className="text-5xl font-bold tracking-tight text-zinc-900">
            Build faster. Ship smarter.
          </h1>
          <p className="mt-3 text-xs text-zinc-500 max-w-md mx-auto">
            The all-in-one platform for modern product teams.
          </p>
          {/* overlapping CTA (issue-1 bbox ~ y:52-60) */}
          <div className="mt-8 flex items-center justify-center">
            <button className="rounded-lg bg-emerald-500 text-white px-4 py-2 text-xs font-medium shadow-lg">
              Get Started Free
            </button>
          </div>
          {/* hero illustration placeholder behind the CTA */}
          <div className="absolute inset-x-12 top-24 h-32 rounded-xl bg-gradient-to-br from-emerald-100 to-sky-100 -z-0 border border-emerald-50" />
        </div>
        {/* newsletter form (issue-5 bbox ~ y:76-83) */}
        <div className="px-8 py-4 text-center">
          <p className="text-[10px] text-zinc-500 mb-2">Stay in the loop</p>
          <div className="inline-flex gap-2">
            <input
              readOnly
              placeholder="Enter your email"
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[10px] w-44"
            />
            <button className="rounded-lg bg-zinc-900 text-white px-3 py-1.5 text-[10px]">
              Subscribe
            </button>
          </div>
        </div>
        {/* footer (issue-2 bbox ~ y:88-94) */}
        <div className="mt-auto px-8 py-3 border-t border-zinc-100">
          <div className="flex justify-between text-[10px] text-gray-400">
            <span>© Acme 2026</span>
            <div className="flex gap-3">
              <span>About</span>
              <span>Privacy</span>
              <span>Terms</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (snapshot === 'pricing') {
    return (
      <div className="w-full h-full bg-white text-zinc-800 font-sans flex flex-col">
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded bg-emerald-500" />
            <span className="text-sm font-semibold">acme</span>
          </div>
          <div className="flex items-center gap-4 text-[10px] text-zinc-500">
            <span>Product</span>
            <span>Pricing</span>
            <span>Docs</span>
            <span className="rounded bg-zinc-900 text-white px-2 py-1">Get Started</span>
          </div>
        </div>
        <div className="px-8 py-6 text-center">
          <h2 className="text-3xl font-bold">Simple, transparent pricing</h2>
          <p className="mt-2 text-[10px] text-zinc-500">Pick the plan that scales with you.</p>
        </div>
        {/* pricing cards — issue-3 bbox covers these (y:32-70) */}
        <div className="px-8 grid grid-cols-3 gap-3 flex-1">
          {['Starter', 'Pro', 'Team'].map((plan, idx) => (
            <div
              key={plan}
              className={cn(
                'rounded-2xl border p-3 text-left',
                idx === 1 ? 'border-emerald-400 bg-emerald-50/50' : 'border-zinc-200',
              )}
            >
              <h3 className="text-xs font-semibold">{plan}</h3>
              <p className="mt-1 text-lg font-bold">${[0, 19, 49][idx]}<span className="text-[9px] text-zinc-500 font-normal">/mo</span></p>
              <p className="mt-1 text-[9px] text-zinc-500">For {plan === 'Starter' ? 'tinkering' : plan === 'Pro' ? 'growing teams' : 'scaling orgs'}</p>
              <button className="mt-2 w-full rounded bg-zinc-900 text-white text-[10px] py-1.5">
                Choose {plan}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-auto px-8 py-3 border-t border-zinc-100 text-[10px] text-gray-400 text-center">
          All plans include unlimited deploys.
        </div>
      </div>
    );
  }

  // features
  return (
    <div className="w-full h-full bg-white text-zinc-800 font-sans flex flex-col">
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-emerald-500" />
          <span className="text-sm font-semibold">acme</span>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-zinc-500">
          <span>Product</span>
          <span>Pricing</span>
          <span>Docs</span>
          <span className="rounded bg-zinc-900 text-white px-2 py-1">Get Started</span>
        </div>
      </div>
      <div className="px-8 py-6">
        <h2 className="text-2xl font-bold text-center">Everything you need</h2>
        <div className="grid grid-cols-2 gap-3 mt-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl border border-zinc-200 p-3">
              <div className="h-6 w-6 rounded bg-emerald-100 mb-2" />
              <h4 className="text-xs font-semibold">Feature {i}</h4>
              <p className="text-[9px] text-zinc-500 mt-1">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit.
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BrowserPreview() {
  const screenshots = useAgentStore((s) => s.screenshots);
  const issues = useAgentStore((s) => s.issues);
  const activeId = useAgentStore((s) => s.activeScreenshotId);
  const setActive = useAgentStore((s) => s.setActiveScreenshot);
  const status = useAgentStore((s) => s.status);

  const active = screenshots.find((s) => s.id === activeId) ?? screenshots[screenshots.length - 1];
  const activeIdx = active ? screenshots.indexOf(active) : -1;

  const visibleIssues = active
    ? issues.filter((i) => {
        // Show all issues on the home snapshot (the marketing site analysis)
        if (active.snapshotKey === 'home') return ['issue-1', 'issue-2', 'issue-4', 'issue-5'].includes(i.id);
        if (active.snapshotKey === 'pricing') return i.id === 'issue-3';
        return false;
      })
    : [];

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur overflow-hidden flex flex-col h-full min-h-0">
      {/* Browser chrome */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/60 bg-background/40">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            disabled={!active || activeIdx === 0}
            onClick={() => activeIdx > 0 && setActive(screenshots[activeIdx - 1].id)}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            disabled={!active || activeIdx >= screenshots.length - 1}
            onClick={() => activeIdx < screenshots.length - 1 && setActive(screenshots[activeIdx + 1].id)}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 flex items-center gap-2 px-3 py-1 rounded-md bg-background/60 border border-border/60 text-[11px] font-mono text-muted-foreground truncate">
          <Globe className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {active ? active.url : 'about:blank'}
          </span>
          {status === 'running' && (
            <Loader2 className="h-3 w-3 animate-spin ml-auto shrink-0 text-emerald-400" />
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Wifi className="h-3 w-3 text-emerald-400" />
          <span className="hidden sm:inline">1440×900</span>
        </div>
      </div>

      {/* Viewport */}
      <div className="relative flex-1 bg-zinc-100 min-h-[340px] overflow-hidden">
        {active ? (
          <motion.div
            key={active.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0"
          >
            <SnapshotContent snapshot={active.snapshotKey} />

            {/* Issue bbox overlays */}
            <AnimatePresence>
              {visibleIssues.map((issue) => {
                const color = SEVERITY_COLOR[issue.severity];
                return (
                  <motion.div
                    key={issue.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                    className="absolute border-2 rounded"
                    style={{
                      left: `${issue.bbox.x}%`,
                      top: `${issue.bbox.y}%`,
                      width: `${issue.bbox.w}%`,
                      height: `${issue.bbox.h}%`,
                      borderColor: color,
                      boxShadow: `0 0 0 2000px ${color}10, 0 0 16px ${color}80`,
                      backgroundColor: `${color}10`,
                    }}
                  >
                    <div
                      className="absolute -top-5 left-0 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold text-white whitespace-nowrap"
                      style={{ backgroundColor: color }}
                    >
                      {issue.severity.toUpperCase()}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {/* Scan effect while analyzing */}
            {status === 'running' && (
              <motion.div
                className="absolute inset-x-0 h-12 bg-gradient-to-b from-transparent via-emerald-400/30 to-transparent"
                animate={{ y: ['-10%', '700%'] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
              />
            )}
          </motion.div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
            <Camera className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-xs">No captures yet</p>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              Browser agent will screenshot pages here
            </p>
          </div>
        )}

        {/* Active capture indicator */}
        {active && (
          <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-background/80 backdrop-blur border border-border/60 text-[10px] font-mono">
            <ScanEye className="h-3 w-3 text-emerald-400" />
            <span>{active.page}</span>
          </div>
        )}
      </div>

      {/* Screenshot thumbnails */}
      {screenshots.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border/60 overflow-x-auto bg-background/40">
          {screenshots.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={cn(
                'shrink-0 px-2.5 py-1 rounded-md text-[10px] font-mono border transition-colors',
                s.id === active?.id
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                  : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border',
              )}
            >
              {s.page}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
