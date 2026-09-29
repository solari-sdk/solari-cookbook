import Link from "next/link";
import AppChrome from "@/components/AppChrome";

export default function RunNotFound() {
  return (
    <AppChrome>
    <div className="mx-auto w-full max-w-5xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-wide text-faint">
        404 — unknown run
      </p>
      <h1 className="display mt-3 text-2xl">
        That run is gone.
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
        Reports are stateless: they live in the server&rsquo;s memory for an hour
        and do not survive a restart. Run the teardown again to get a fresh one.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-lg bg-foreground px-3 py-2 font-mono text-xs text-background transition-opacity hover:opacity-90"
      >
        ← start a new run
      </Link>
    </div>
    </AppChrome>
  );
}
