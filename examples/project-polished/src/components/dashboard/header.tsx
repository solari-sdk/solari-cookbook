'use client';

import { motion } from 'framer-motion';
import { Sparkles, Github, Zap, KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useSolariStatus } from '@/hooks/use-solari-status';

export function Header() {
  const { status, loading } = useSolariStatus();

  return (
    <header className="border-b border-border/60 bg-background/80 backdrop-blur-xl sticky top-0 z-30">
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20 }}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20"
            >
              <Sparkles className="h-5 w-5 text-emerald-950" />
            </motion.div>
            <div>
              <h1 className="text-base font-semibold tracking-tight leading-none">
                Project Polished
              </h1>
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-none">
                Autonomous UI/UX revamp agent · powered by Solari
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Solari API key status badge */}
            {!loading && status?.hasApiKey && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="hidden sm:inline-flex gap-1.5 font-mono text-[10px] border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    >
                      {status.liveMode ? (
                        <ShieldCheck className="h-3 w-3" />
                      ) : (
                        <KeyRound className="h-3 w-3" />
                      )}
                      {status.keyPreview}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {status.liveMode
                      ? `Live mode — real Solari API calls enabled (SDK v${status.sdkVersion})`
                      : `Solari API key configured — demo mode active (SDK v${status.sdkVersion})`}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            <Badge variant="outline" className="hidden md:inline-flex gap-1.5 font-mono text-[10px]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              solari-sdk v{status?.sdkVersion ?? '0.4.2'}
            </Badge>
            <Button asChild size="sm" variant="ghost" className="gap-1.5">
              <a
                href="https://github.com/solari-sdk/solari-cookbook"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="h-4 w-4" />
                <span className="hidden sm:inline">Cookbook</span>
              </a>
            </Button>
            <Button asChild size="sm" className="gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-emerald-950">
              <a
                href="https://github.com/solari-sdk/solari-cookbook"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Zap className="h-3.5 w-3.5" />
                Fork & Ship
              </a>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
