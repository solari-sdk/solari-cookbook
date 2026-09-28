// Adapted from pingdotgg/t3code apps/web/src/components/ui/dialog.tsx at 57a66608 (MIT).
"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
} from "./dialog-styles";
import { ScrollArea } from "./scroll-area";

const DialogCreateHandle = DialogPrimitive.createHandle;

const Dialog = DialogPrimitive.Root;

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(DIALOG_BACKDROP_CLASS, className)}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  bottomStickOnMobile = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogViewport
        className={cn(bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12")}
      >
        <DialogPrimitive.Popup
          className={cn(
            DIALOG_POPUP_CLASS,
            "row-start-2 max-h-full max-w-lg text-popover-foreground",
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

/** The popup as a sheet over the whole window: the shell blurred behind it, the close 20 px from the top right, and
 * nothing scrolling but what the content scrolls itself. The glass makes the popup the containing block of anything
 * fixed in it, so what is pinned to a corner (the close, `aside`) sits beside the content, not in it. */
function DialogSheet({ className, children, aside, ...props }: DialogPrimitive.Popup.Props & { aside?: React.ReactNode }) {
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogViewport className="grid-rows-[1fr] p-0">
        <DialogPrimitive.Popup
          className={cn(
            "dialog-glass relative h-full w-full overflow-hidden rounded-none border-0 text-foreground outline-none transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          data-slot="dialog-sheet"
          {...props}
        >
          <div data-slot="dialog-sheet-body" className="h-full w-full overflow-hidden">
            {children}
          </div>
          {aside}
          <DialogPrimitive.Close aria-label="Close" className="fixed top-5 right-5" render={<Button size="icon" variant="ghost" />}>
            <XIcon />
          </DialogPrimitive.Close>
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "py-4",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("font-heading font-semibold text-xl leading-none", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollFade = true,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  DialogCreateHandle,
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogSheet,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
