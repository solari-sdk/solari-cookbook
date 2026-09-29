import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AppChrome from "@/components/AppChrome";
import ReplayPlayer from "@/components/ReplayPlayer";
import { getRun } from "@/lib/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Session replay",
  robots: { index: false, follow: false },
};

export default async function ReplayPage(props: PageProps<"/replay/[id]">) {
  const { id } = await props.params;
  const run = getRun(id);

  if (!run?.replay) notFound();

  return (
    <AppChrome>
      <ReplayPlayer runId={run.id} targetUrl={run.url} />
    </AppChrome>
  );
}
