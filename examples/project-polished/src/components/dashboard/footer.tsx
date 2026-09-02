'use client';

import { Sparkles, Github, Twitter, Linkedin, Heart } from 'lucide-react';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background/60 backdrop-blur">
      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600">
              <Sparkles className="h-3.5 w-3.5 text-emerald-950" />
            </div>
            <div>
              <p className="text-xs font-medium leading-tight">Project Polished</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                Built for the Solari SDK Bounty · fork the cookbook and ship your own
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              Tag{' '}
              <a href="https://twitter.com/harrychow_" target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-400 hover:underline">
                @harrychow_
              </a>{' '}
              ·{' '}
              <a href="https://twitter.com/getsolari" target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-400 hover:underline">
                @getsolari
              </a>
            </span>
            <span className="hidden sm:inline-flex items-center gap-1">
              Built with <Heart className="h-3 w-3 text-rose-400 fill-rose-400" /> using AI pair programming
            </span>
            <div className="flex items-center gap-1.5">
              <a
                href="https://github.com/solari-sdk/solari-cookbook"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="GitHub"
              >
                <Github className="h-4 w-4" />
              </a>
              <a
                href="https://twitter.com/intent/tweet?text=Just%20shipped%20Project%20Polished%20with%20%40getsolari%20%40harrychow_"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="X / Twitter"
              >
                <Twitter className="h-4 w-4" />
              </a>
              <a
                href="https://www.linkedin.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="LinkedIn"
              >
                <Linkedin className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
