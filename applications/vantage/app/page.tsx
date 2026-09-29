import type { Metadata } from "next";
import VantageLanding from "@/components/VantageLanding";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/brand";

// Title only. The description, share card, theme colour, and robots rules all
// come from the root layout, so the <meta name="description"> and the Open
// Graph copy can never drift apart.
export const metadata: Metadata = {
  title: { absolute: `${SITE_NAME} — ${SITE_TAGLINE}` },
};

export default function Home() {
  return <VantageLanding />;
}
