// Adapted from pingdotgg/t3code apps/web/src/components/ui/skeleton.tsx at 57a66608 (MIT).
// The bar stands in the hairline tier rather than the muted fill: on a card,
// which is the popover's own white in light, the muted fill is 3 of 255 from
// what it sits on and a row of bars read as a row of blanks (measured in the
// import dialog, both themes).
import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm bg-border [--skeleton-highlight:--alpha(var(--color-white)/64%)] after:absolute after:inset-0 after:animate-skeleton after:bg-[linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)] motion-reduce:after:content-none dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
