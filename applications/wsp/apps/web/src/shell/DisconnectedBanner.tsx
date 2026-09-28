// SPDX-License-Identifier: AGPL-3.0-only
// Shown while the runtime socket is down. The client redials on its own
// after a drop, so the banner clears itself when the socket comes back;
// a closed socket (refused token, or closed on purpose) needs a reload.
import { Unplug } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";

export function DisconnectedBanner({ reconnecting }: { reconnecting: boolean }) {
  return (
    <Alert className="m-2 shrink-0" data-disconnected-banner={reconnecting ? "reconnecting" : "closed"}>
      <Unplug />
      <AlertTitle>{reconnecting ? "wsp is not running, reconnecting." : "wsp is not running."}</AlertTitle>
      <AlertDescription>
        {reconnecting
          ? "The runtime socket dropped. Start wsp in a terminal and this page picks it up on its own."
          : "Start wsp in a terminal, then reload this page."}
      </AlertDescription>
      {reconnecting ? null : (
        <AlertAction>
          <Button size="compact" variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
