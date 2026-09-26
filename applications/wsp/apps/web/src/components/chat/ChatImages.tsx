// SPDX-License-Identifier: AGPL-3.0-only
// The one way an image is drawn in the chat: a square thumbnail that opens the
// image at full size in a dialog, used above the composer for what is about to
// go and inside a person's message for what went. A message whose bytes this
// tab does not hold, a transcript replayed after a reload or one another
// client sent, has the runtime's record instead of pixels and draws the same
// muted mono line the command line prints.
import { XIcon } from "lucide-react";
import { imageLine, type ImageRecord } from "@wsp/protocol";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import type { ComposerImage } from "./composerImages";

/** One image at full size behind its thumbnail. The labels count the images of the message, as the refusal words do,
 * since two pastes of one clipboard carry the same name and a name alone would not tell the two buttons apart; the
 * name is the title and the alt text. */
export function ChatImageThumb({ image, at, onRemove }: { image: ComposerImage; at: number; onRemove?: () => void }) {
  return (
    <div className="group/thumb relative" data-chat-image={image.name}>
      <Dialog>
        <DialogTrigger
          render={
            <button
              type="button"
              aria-label={`Open image ${at} at full size`}
              title={image.name}
              className="block size-14 overflow-hidden rounded-lg border border-border/60 bg-card/50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <img src={image.url} alt={image.name} className="size-full object-cover" />
        </DialogTrigger>
        <DialogPopup className="w-auto max-w-[90vw] p-2">
          <DialogTitle className="sr-only">{image.name}</DialogTitle>
          <img src={image.url} alt={image.name} className="max-h-[80vh] max-w-[86vw] rounded-md object-contain" />
        </DialogPopup>
      </Dialog>
      {onRemove ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Remove image ${at}`}
          title={`Remove ${image.name}`}
          onClick={onRemove}
          className="-end-1.5 -top-1.5 absolute size-5 rounded-full border border-border/60 bg-card opacity-0 transition-opacity group-hover/thumb:opacity-100 focus-visible:opacity-100"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}

/** What a message's images come to on screen: its thumbnails where this tab holds their bytes, else one muted mono
 * line per image, the same words the command line prints on the person's turn. */
export function ChatImageRow({ records, images }: { records: ReadonlyArray<ImageRecord>; images: ReadonlyArray<ComposerImage> }) {
  if (records.length === 0) return null;
  if (images.length === records.length) {
    return (
      <div className="mb-2 flex flex-wrap gap-1.5" data-chat-image-row="true">
        {images.map((image, at) => (
          <ChatImageThumb key={image.id} image={image} at={at + 1} />
        ))}
      </div>
    );
  }
  return (
    <div className="mb-1 flex flex-col gap-0.5" data-chat-image-row="records">
      {records.map((record, index) => (
        <span key={`${record.name ?? "image"}:${index}`} className="font-mono text-[11px] leading-4 text-muted-foreground">
          {imageLine(record)}
        </span>
      ))}
    </div>
  );
}
