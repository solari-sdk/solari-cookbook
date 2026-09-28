// SPDX-License-Identifier: AGPL-3.0-only
// The terminal pane's one setting: the family it draws with, typed by name.
// The button and the card are separate so the pane can place the card outside
// its clipped action strip; the card is plain markup, not a portal, so it lives
// inside the pane it configures and needs nothing from the app around it.
import { Type } from "lucide-react";
import { useId } from "react";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { useTerminalFont } from "../terminal/fontSetting";
import { DEFAULT_TERMINAL_TEXT_FACES } from "../terminal/ghostty/fontChain";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export const TERMINAL_FONT_LABEL = "Terminal font";
/** The first face the pane asks for when nothing is chosen or detected, unquoted. */
const DEFAULT_FACE = DEFAULT_TERMINAL_TEXT_FACES.split(",")[0]!.trim().replace(/^"(.*)"$/, "$1");

export function TerminalFontButton({ className, open, onToggle }: { className: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={className} aria-label={TERMINAL_FONT_LABEL} title={TERMINAL_FONT_LABEL} aria-expanded={open} onClick={onToggle}>
      <Type className="size-3.25" />
    </button>
  );
}

export function TerminalFontCard({ className, onClose }: { className?: string; onClose: () => void }) {
  const { family, detected, setFamily } = useTerminalFont();
  const field = useCommitOnBlur(family, setFamily);
  const id = useId();
  const whenEmpty = detected !== undefined ? `Empty draws with ${detected}, your terminal's font.` : "Empty draws with the default font.";
  return (
    <div
      className={cn("flex w-72 flex-col gap-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md", className)}
      onKeyDown={event => {
        if (event.key === "Escape") onClose();
      }}
    >
      <Label htmlFor={id}>{TERMINAL_FONT_LABEL}</Label>
      <Input id={id} nativeInput size="compact" placeholder={detected ?? DEFAULT_FACE} autoComplete="off" spellCheck={false} autoFocus {...field} />
      <p className="text-xs text-muted-foreground">A font installed on this computer. {whenEmpty} Icons a face lacks come from a bundled symbols font.</p>
    </div>
  );
}
