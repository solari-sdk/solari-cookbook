// SPDX-License-Identifier: AGPL-3.0-only
// One bar per sign-in page waiting. The bar names the URL's host so the click
// is never blind; the full URL (it carries the flow's state) shows on hover
// only. Open goes through window.open, which the desktop shell hands to the
// default browser.
import { hostOf } from "@wsp/protocol";
import { ExternalLink } from "lucide-react";
import { Alert, AlertAction, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { useStore } from "../protocol/store.js";
import { useSignInStore } from "./signInStore.js";

export function SignInBanner() {
  const pages = useSignInStore(s => s.pages);
  const dismiss = useSignInStore(s => s.dismiss);
  const workspaces = useStore(s => s.workspaces);
  const entries = Object.entries(pages);
  if (entries.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 p-2" data-testid="sign-in-banner">
      {entries.map(([key, { workspaceId, url }]) => {
        const host = hostOf(url);
        return (
          <Alert key={key} data-sign-in-banner={key} title={url}>
            <ExternalLink />
            <AlertTitle>
              {host === undefined ? "A sign-in page" : `A sign-in page for ${host}`} is ready on{" "}
              {workspaces.find(w => w.id === workspaceId)?.name ?? workspaceId}
            </AlertTitle>
            <AlertAction>
              <Button size="compact" variant="outline" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
                Open
              </Button>
              <Button size="compact" variant="ghost" onClick={() => dismiss(key)}>
                Dismiss
              </Button>
            </AlertAction>
          </Alert>
        );
      })}
    </div>
  );
}
