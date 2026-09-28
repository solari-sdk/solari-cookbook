// Adapted from pingdotgg/t3code apps/web/src/components/chat/PierreEntryIcon.tsx at 57a66608 (MIT).
import { FileIcon, FolderIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";

export const PierreEntryIcon = memo(function PierreEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  theme: "light" | "dark";
  className?: string;
}) {
  return props.kind === "directory" ? (
    <FolderIcon className={cn("size-4 text-icon-muted", props.className)} />
  ) : (
    <FileIcon className={cn("size-4 text-icon-muted", props.className)} />
  );
});
