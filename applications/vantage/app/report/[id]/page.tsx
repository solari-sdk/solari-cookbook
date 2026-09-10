import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AppChrome from "@/components/AppChrome";
import RunView, { type RunSnapshot } from "@/components/RunView";
import { getRun } from "@/lib/store";

export const dynamic = "force-dynamic";

// A run holds someone else's research and expires in an hour — keep it out of
// search results and out of link previews.
export const metadata: Metadata = {
  title: "Teardown",
  robots: { index: false, follow: false },
};

export default async function ReportPage(props: PageProps<"/report/[id]">) {
  const { id } = await props.params;
  const run = getRun(id);

  // Runs live in process memory only — a restarted server has no history.
  if (!run) notFound();

  const snapshot: RunSnapshot = {
    id: run.id,
    url: run.url,
    provider: run.provider,
    model: run.model,
    status: run.status,
    createdAt: run.createdAt,
    events: run.events,
    report: run.report,
    error: run.error,
    durationMs: run.durationMs,
    replay: run.replay,
    demo: run.demo,
  };

  return (
    <AppChrome>
      <RunView initial={snapshot} />
    </AppChrome>
  );
}
