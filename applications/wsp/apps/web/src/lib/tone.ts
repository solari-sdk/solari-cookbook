// SPDX-License-Identifier: AGPL-3.0-only
// The text and fill classes for the protocol's tones, read by every surface
// that colours a number by the size table or the share table: the setup's size
// cells, tallies and meter, and the machine tab's live rows, so one tone is one
// ink wherever it is read.
import type { SizeTone } from "@wsp/protocol";

export const TONE_TEXT: Record<SizeTone, string> = { danger: "text-destructive-foreground", warning: "text-warning-foreground", yellow: "text-yellow-foreground", muted: "text-muted-foreground" };
export const TONE_FILL: Record<SizeTone, string> = { danger: "bg-destructive-foreground", warning: "bg-warning-foreground", yellow: "bg-yellow-foreground", muted: "bg-muted-foreground" };
