// Adapted from pingdotgg/t3code apps/web/src/components/preview/PreviewEmptyState.tsx at 57a66608 (MIT).
// useDiscoveredLocalServers is the `servers` prop; threadRef, environmentId and configuredUrls dropped.
import { Globe, History, RadioTower } from "lucide-react";

import type { PreviewableServer } from "../../adapt/view-model";
import { relativeLabel, type BrowserHistoryEntry } from "../../browser/recents";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "../ui/empty";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";

interface Props {
  servers: ReadonlyArray<PreviewableServer>;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({ servers, recentEntries, onRemoveRecent, onOpenUrl }: Props) {
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);
  const now = Date.now();

  if (servers.length === 0 && recents.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No preview yet</EmptyTitle>
        <EmptyDescription>
          Type a port above, or run a dev script. Servers listening on this task will show up
          here automatically.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {recents.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="size-4 shrink-0" />
              <h2 className="font-medium">Recently used</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  entry={entry}
                  visitedLabel={relativeLabel(entry.lastVisitedAt, now)}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {servers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RadioTower className="size-4 shrink-0" />
              <h2 className="font-medium">Local servers</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Select a live local server to open it in this browser tab.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
