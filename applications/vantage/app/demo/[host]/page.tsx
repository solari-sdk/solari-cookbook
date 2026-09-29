import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import AppChrome from "@/components/AppChrome";
import DemoRunView, { type DemoFixture } from "@/components/DemoRunView";
import { DEMO_HOSTS } from "@/lib/demo";

export const metadata: Metadata = {
  title: "Saved run",
  robots: { index: false, follow: false },
};

/** Pre-rendered at build time, so the page needs nothing at request time. */
export function generateStaticParams() {
  return DEMO_HOSTS.map((host) => ({ host }));
}

export const dynamicParams = false;

function loadFixture(host: string): DemoFixture | null {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "public", "demo", `${host}.json`), "utf8"),
    ) as DemoFixture;
  } catch {
    return null;
  }
}

export default async function DemoPage(props: PageProps<"/demo/[host]">) {
  const { host } = await props.params;
  const fixture = loadFixture(host);

  // A host with no captured run is not an error — it just has not been run
  // yet. Say so and point at the ones that are ready.
  if (!fixture) {
    const ready = DEMO_HOSTS.filter((candidate) => loadFixture(candidate));
    return (
      <AppChrome>
        <div className="mx-auto w-full max-w-2xl px-6 py-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">
            Not captured yet
          </p>
          <h1 className="display mt-3 text-3xl">No saved run for {host}</h1>
          <p className="mt-4 leading-relaxed text-muted">
            Saved runs are only created from real ones, so this host has not been
            analysed yet. Run it live with your own model key, or replay one that
            has been captured.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-2">
            {ready.map((candidate) => (
              <Link
                key={candidate}
                href={`/demo/${candidate}`}
                className="glass-soft rounded-lg px-3 py-2 font-mono text-xs text-foreground transition-colors hover:border-accent"
              >
                ▶ {candidate}
              </Link>
            ))}
            <Link
              href="/"
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              ← Back to home
            </Link>
          </div>
        </div>
      </AppChrome>
    );
  }

  return (
    <AppChrome>
      <DemoRunView fixture={fixture} />
    </AppChrome>
  );
}
