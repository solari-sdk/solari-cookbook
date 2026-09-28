// Adapted from pingdotgg/t3code apps/web/src/components/chat/PanelLayoutControls.tsx at 57a66608 (MIT).
import { Maximize2Icon, Minimize2Icon, PanelBottomIcon, PanelRightIcon } from "lucide-react";
import { memo } from "react";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PanelLayoutControlsProps {
  showTerminalControl?: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  /** Running + waiting subagents in this thread; badges the right panel toggle. */
  liveAgentCount: number;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showTerminalControl = true,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelOpen,
  rightPanelShortcutLabel,
  liveAgentCount,
  onToggleTerminal,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="ghost"
              size="sm"
            >
              <PanelBottomIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {`Toggle terminal drawer${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={rightPanelOpen}
            onPressedChange={onToggleRightPanel}
            aria-label={
              liveAgentCount > 0
                ? `Toggle right panel, ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
                : "Toggle right panel"
            }
            variant="ghost"
            size="sm"
          >
            <PanelRightIcon className="size-4" />
            {liveAgentCount > 0 ? (
              <span
                aria-hidden
                className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-[9px] font-semibold tabular-nums text-white"
              >
                {liveAgentCount}
              </span>
            ) : null}
          </Toggle>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {`Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}${
            liveAgentCount > 0 ? `, ${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working` : ""
          }`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});
