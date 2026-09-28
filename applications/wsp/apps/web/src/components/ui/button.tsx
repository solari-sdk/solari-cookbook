// Adapted from pingdotgg/t3code apps/web/src/components/ui/button.tsx at 57a66608 (MIT).
"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

/** The keycap bevel: a 1 px light along the inside of the top edge, turned to a 1 px shade while pressed. */
const KEYCAP_BEVEL = "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)]";
/** The hairline and fill a held primary takes in place of its own: read from here by a control that is drawn by hand rather than by this file, so the held look has one home. */
const HELD_SURFACE = "border-input bg-popover dark:bg-input/32";
/** The secondary's body: the held hairline and fill, no bevel, and a 1 px shade under the bottom edge in light. */
const OUTLINE_SURFACE = `${HELD_SURFACE} not-dark:bg-clip-padding shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] [:disabled,:active,[data-pressed]]:shadow-none`;
/** The outline's faint dark-theme edge light, on the border pixel rather than inside it. */
const OUTLINE_DARK_EDGE = "dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)]";

/** The ring a control takes where the accent would be a third hue on one screen: a destructive confirm, and the
 * Cancel standing beside it. A blue ring between a neutral button and a red one says nothing about either. */
const NEUTRAL_RING = "focus-visible:ring-muted-foreground";

/** The inset a button pulls its glyphs in by. A control that is not a button but has to line up with one beside it
 * wears the same inset, so it is read from here rather than spelled again. */
const BUTTON_GLYPH_INSET = "[&_svg]:-mx-0.5";

const buttonVariants = cva(
  `[--control-icon-color:currentColor] ${BUTTON_GLYPH_INSET} relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0`,
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-micro":
          "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        micro:
          "h-5 gap-1 rounded-sm px-[calc(--spacing(1.5)-1px)] text-[11px] before:rounded-[calc(var(--radius-sm)-1px)] sm:text-[11px] [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default: `${KEYCAP_BEVEL} border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-primary/90`,
        destructive: `${KEYCAP_BEVEL} ${NEUTRAL_RING} border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-destructive/90`,
        "destructive-outline": `${OUTLINE_SURFACE} ${OUTLINE_DARK_EDGE} text-destructive-foreground [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4`,
        ghost:
          "[--control-icon-color:var(--muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        "ghost-muted":
          "[--control-icon-color:var(--muted-foreground)] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
        glass:
          "surface-glass [--control-icon-color:var(--muted-foreground)] border-border/60 text-foreground shadow-sm [:hover,[data-pressed]]:border-border",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        keycap: `${OUTLINE_SURFACE} ${KEYCAP_BEVEL} [--control-icon-color:var(--muted-foreground)] text-foreground [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64`,
        outline: `${OUTLINE_SURFACE} ${OUTLINE_DARK_EDGE} [--control-icon-color:var(--muted-foreground)] text-foreground [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64`,
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
      },
    },
  },
);

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  /** A control that cannot be pressed yet, waiting on a field beside it: it is drawn as the outline variant and
   * disabled, at the size and in the slot the live one has, and takes its own variant back the moment it can be
   * pressed. The reason it waits belongs in the slot under that field, never on a hover. Being busy is not this:
   * a pressed control keeps its variant and changes its word. */
  held?: boolean;
}

function Button({ className, variant, size, held = false, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant: held ? "outline" : variant }), held && HELD_DIM),
    "data-slot": "button",
    type: typeValue,
  };
  const heldProps = { "data-held": "", disabled: true };

  return useRender({
    defaultTagName: "button",
    // Last, so a caller that disables for its own reason cannot hand a held control back to the hand.
    props: mergeProps<"button">(defaultProps, props, held ? heldProps : {}),
    render,
  });
}

/** How far a held control falls: the generic disabled step reads as the live outline beside it in a row's slot, so
 * a control waiting on a road nobody has takes half the ink and edge of one that can be pressed. Opacity alone,
 * since a held control that changed colour would be saying something other than that it cannot be pressed. */
const HELD_DIM = "disabled:opacity-50";

/** A door to a confirmation for something that does not come back: neutral at rest, as every other action in a
 * row's slot is, and the danger ink and edge under the pointer. The act itself is the dialog's button, which is
 * where red stands at rest, so no page carries more than one loud thing. */
const DANGER_BUTTON = "transition-[color,border-color,box-shadow] duration-150 [:hover,[data-pressed]]:border-destructive/50 [:hover,[data-pressed]]:text-destructive-foreground";

export { Button, BUTTON_GLYPH_INSET, buttonVariants, DANGER_BUTTON, HELD_SURFACE, NEUTRAL_RING };
