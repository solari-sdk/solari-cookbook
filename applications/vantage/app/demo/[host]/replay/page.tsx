import type { Metadata } from "next";
import AppChrome from "@/components/AppChrome";
import ReplayPlayer from "@/components/ReplayPlayer";
import { DEMO_HOSTS } from "@/lib/demo";

export const metadata: Metadata = {
  title: "Session replay",
  robots: { index: false, follow: false },
};

export function generateStaticParams() {
  return DEMO_HOSTS.map((host) => ({ host }));
}

export const dynamicParams = false;

export default async function DemoReplayPage(
  props: PageProps<"/demo/[host]/replay">,
) {
  const { host } = await props.params;
  return (
    <AppChrome>
      <ReplayPlayer
        runId={`demo/${host}`}
        targetUrl={`https://${host}/`}
        eventsUrl={`/demo/${host}.replay.json`}
        backHref={`/demo/${host}`}
      />
    </AppChrome>
  );
}
