// SPDX-License-Identifier: AGPL-3.0-only
// One slider for the app: a hairline track, the filled part in the foreground
// ink, a round thumb, no value bubble. The caller puts the label and the value
// beside it in its own grammar.
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "../../lib/utils.js";

export function Slider({ className, "aria-label": label, ...props }: SliderPrimitive.Root.Props<number> & { "aria-label": string }) {
  return (
    <SliderPrimitive.Root className={cn("flex w-full touch-none items-center select-none", className)} data-slot="slider" {...props}>
      <SliderPrimitive.Control className="flex h-5 w-full items-center">
        <SliderPrimitive.Track className="relative h-px w-full bg-border">
          <SliderPrimitive.Indicator className="absolute h-full bg-foreground/60" />
          <SliderPrimitive.Thumb aria-label={label} className="size-3 rounded-full border border-foreground/60 bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
