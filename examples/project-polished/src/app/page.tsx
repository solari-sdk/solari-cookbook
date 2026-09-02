'use client';

import { Header } from '@/components/dashboard/header';
import { RepoInput } from '@/components/dashboard/repo-input';
import { PipelineTracker } from '@/components/dashboard/pipeline-tracker';
import { ActivityLog } from '@/components/dashboard/activity-log';
import { BrowserPreview } from '@/components/dashboard/browser-preview';
import { IssuesPanel } from '@/components/dashboard/issues-panel';
import { DiffPanel } from '@/components/dashboard/diff-panel';
import { PrSummary } from '@/components/dashboard/pr-summary';
import { Footer } from '@/components/dashboard/footer';

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />

      <main className="flex-1 mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        {/* Hero / intro band */}
        <section className="rounded-2xl border border-border/60 bg-gradient-to-br from-emerald-500/5 via-transparent to-transparent p-5 sm:p-7">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-mono text-emerald-300 mb-3">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Solari Bounty Submission · @harrychow_ · @getsolari
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">
                Drop a repo. <span className="text-emerald-400">Get a polished UI PR.</span>
              </h2>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                An autonomous agent that sandboxes any public repo, drives a headless browser to
                capture every page, runs a vision model to flag UX defects, then uses Solari&apos;s
                desktop automation to open VS Code and write surgical CSS / a11y fixes — pushed as a
                ready-to-merge pull request.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 shrink-0">
              <HeroStat value="6" label="agent stages" />
              <HeroStat value="3" label="envs" sublabel="browser · sandbox · desktop" />
              <HeroStat value="< 60s" label="end-to-end" />
            </div>
          </div>
        </section>

        {/* Step 1: repo input */}
        <RepoInput />

        {/* Main workspace grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left rail: pipeline + activity */}
          <div className="lg:col-span-3 flex flex-col gap-5">
            <PipelineTracker />
          </div>

          {/* Center: browser preview + diffs */}
          <div className="lg:col-span-6 flex flex-col gap-5">
            <BrowserPreview />
            <DiffPanel />
          </div>

          {/* Right rail: issues + PR */}
          <div className="lg:col-span-3 flex flex-col gap-5">
            <IssuesPanel />
            <PrSummary />
          </div>
        </div>

        {/* Activity log full width below */}
        <ActivityLog />
      </main>

      <Footer />
    </div>
  );
}

function HeroStat({ value, label, sublabel }: { value: string; label: string; sublabel?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur px-3 py-2.5 text-center min-w-[88px]">
      <div className="text-xl font-bold tabular-nums leading-none text-emerald-400">{value}</div>
      <div className="text-[10px] text-muted-foreground mt-1 leading-tight">{label}</div>
      {sublabel && (
        <div className="text-[9px] text-muted-foreground/70 mt-0.5 leading-tight">{sublabel}</div>
      )}
    </div>
  );
}
