import type { Metadata } from "next";
import Link from "next/link";
import VantageBackdrop from "@/components/VantageBackdrop";

export const metadata: Metadata = { title: "Page not found" };

/**
 * Global 404. Uses the same backdrop and display face as the landing, but
 * scrolls normally — it is a working surface, not the fixed hero composition.
 */
export default function NotFound() {
  return (
    <>
      <VantageBackdrop scrim />
      <div className="over-backdrop flex min-h-screen flex-col items-center justify-center px-6 py-20 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-faint">
          404
        </p>

        <h1 className="display mt-5 max-w-2xl text-4xl sm:text-5xl">
          Nothing to see here.
        </h1>

        <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
          That page does not exist. If you were looking for a teardown, reports
          live in memory for an hour and do not survive a restart — run a fresh
          one from the home page.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg bg-foreground px-5 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Run Agent →
          </Link>
          <Link
            href="/settings"
            className="glass-soft rounded-lg px-5 py-3 font-mono text-xs text-foreground transition-colors hover:border-accent"
          >
            settings
          </Link>
        </div>
      </div>
    </>
  );
}
