'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Github, Play, Loader2, RotateCcw, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAgentStore } from '@/store/agent-store';
import { runAgentPipeline } from '@/lib/agent-engine';
import { DEMO_REPOS } from '@/lib/agent-data';

export function RepoInput() {
  const [localUrl, setLocalUrl] = useState('');
  const status = useAgentStore((s) => s.status);
  const isBusy = status === 'running';

  const handleStart = () => {
    const url = localUrl.trim() || DEMO_REPOS[0].url;
    setLocalUrl(url);
    void runAgentPipeline(url);
  };

  const handleReset = () => {
    useAgentStore.getState().reset();
    setLocalUrl('');
  };

  const handlePickDemo = (url: string) => {
    setLocalUrl(url);
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur p-5 sm:p-6">
      <div className="flex flex-col gap-1.5 mb-4">
        <div className="flex items-center gap-2">
          <Github className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">Target Repository</h2>
          <Badge variant="secondary" className="text-[10px] font-mono">step 1</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Drop any public GitHub repo. The Solari agent will sandbox it, crawl the routes with a
          headless browser, audit the UI with a vision model, then drive VS Code to write fixes.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Github className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={localUrl}
            onChange={(e) => setLocalUrl(e.target.value)}
            placeholder="https://github.com/your-org/your-repo"
            className="pl-9 pr-3 font-mono text-sm h-11 bg-background/60"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isBusy) handleStart();
            }}
            disabled={isBusy}
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="default" className="h-11 gap-1.5" disabled={isBusy}>
              <span className="hidden sm:inline">Demos</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            {DEMO_REPOS.map((repo) => (
              <DropdownMenuItem
                key={repo.url}
                onClick={() => handlePickDemo(repo.url)}
                className="flex flex-col items-start gap-0.5 py-2"
              >
                <span className="font-mono text-xs">{repo.url}</span>
                <span className="text-[11px] text-muted-foreground">{repo.description}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {status === 'completed' || status === 'failed' ? (
          <Button
            onClick={handleReset}
            variant="outline"
            className="h-11 gap-1.5"
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </Button>
        ) : (
          <Button
            onClick={handleStart}
            disabled={isBusy}
            className="h-11 gap-1.5 bg-emerald-500 hover:bg-emerald-600 text-emerald-950 font-medium"
          >
            {isBusy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Running...</span>
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                <span>Run Agent</span>
              </>
            )}
          </Button>
        )}
      </div>

      {!localUrl && !isBusy && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-3 text-[11px] text-muted-foreground/80"
        >
          Tip: pick a demo repo above, or paste any public GitHub URL. No setup required — the agent
          handles everything inside the sandbox.
        </motion.p>
      )}
    </div>
  );
}
