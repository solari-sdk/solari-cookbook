// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessageCopyButton.tsx at 57a66608 (MIT).
import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { noticeFailure } from "../../notices/store";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const COPIED_MS = 1500;

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: COPIED_MS, onError: error => noticeFailure(error, said => `Not copied: ${said}`) });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy link"
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            type="button"
            size={size}
            variant={variant}
            className={cn("text-muted-foreground hover:text-foreground", className)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>Copy to clipboard</p>
      </TooltipPopup>
    </Tooltip>
  );
});
