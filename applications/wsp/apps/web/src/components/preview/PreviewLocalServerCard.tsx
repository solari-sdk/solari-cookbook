// Adapted from pingdotgg/t3code apps/web/src/components/preview/PreviewLocalServerCard.tsx at 57a66608 (MIT).
// threadRef dropped (favicons are not looked up). No dot beside the address:
// every row on this list is a port that is listening, so a dot on each of them
// is the same word said as many times as there are rows.
import type { PreviewableServer } from "../../adapt/view-model";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";

interface Props {
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ server, onOpen }: Props) {
  const subtitle = describeServer(server);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <PreviewFaviconIcon />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{subtitle}</span>
        <span className="truncate text-xs text-muted-foreground">
          {server.host}:{server.port}
        </span>
      </div>
    </button>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  return "Listening";
}
