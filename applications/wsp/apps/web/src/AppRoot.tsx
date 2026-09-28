// SPDX-License-Identifier: AGPL-3.0-only
// Renderer-wide providers around the app; the page mounts this once.
import { StrictMode } from "react";
import { Root, type AppProps } from "./App.js";
import { TooltipProvider } from "./components/ui/tooltip.js";

export type AppRootProps = AppProps;

export function AppRoot(props: AppRootProps) {
  return (
    <StrictMode>
      <TooltipProvider>
        <Root {...props} />
      </TooltipProvider>
    </StrictMode>
  );
}
