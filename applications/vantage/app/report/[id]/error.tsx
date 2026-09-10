"use client";

import Link from "next/link";
import AppChrome from "@/components/AppChrome";
import { useEffect } from "react";

export default function ReportError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[report]", error);
  }, [error]);

  return (
    <AppChrome>
    <div className="mx-auto w-full max-w-5xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-wide text-danger">
        Report crashed
      </p>
      <h1 className="display mt-3 text-2xl">
        Something broke while rendering this teardown.
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
        {error.message || "An unexpected error occurred."}
        {error.digest ? (
          <span className="ml-2 font-mono text-xs text-faint">({error.digest})</span>
        ) : null}
      </p>
      <div className="mt-6 flex gap-2">
        <button
          onClick={reset}
          className="rounded-lg bg-foreground px-3 py-2 font-mono text-xs text-background transition-opacity hover:opacity-90"
        >
          retry
        </button>
        <Link
          href="/"
          className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground"
        >
          ← home
        </Link>
      </div>
    </div>
    </AppChrome>
  );
}
