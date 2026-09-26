// SPDX-License-Identifier: AGPL-3.0-only
// The toasts: top right of the centre pane, under the header row, newest on
// top, three at most.
import { Toast } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { NOTICE_LIMIT, noticeTimeout, useNotices, type Notice as NoticeRecord } from "./store.js";

export const CLOSE_NOTICE_LABEL = "Close this message";

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Escape belongs to whatever holds the focus first: a field, a dialog, a menu, or a toast, which base-ui closes itself. */
const ownsEscape = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [data-notices], [role=dialog], [role=alertdialog], [role=menu], [role=listbox]") !== null);

function Notice({ toast }: { toast: Toast.Root.ToastObject<{ notice: NoticeRecord }> }) {
  const notice = toast.data?.notice;
  if (notice === undefined) return null;
  const { action } = notice;
  return (
    <Toast.Root
      toast={toast}
      swipeDirection="right"
      data-notice=""
      data-kind={notice.kind}
      className={cn(
        "pointer-events-auto relative w-full rounded-md border bg-popover text-popover-foreground shadow-md/5 not-dark:bg-clip-padding",
        "transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none",
        "data-starting-style:translate-y-[2px] data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:hidden",
        "data-ending-style:data-[swipe-direction=right]:translate-x-[calc(var(--toast-swipe-movement-x)+100%)]",
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className={cn("w-12 shrink-0 font-mono text-[11px] leading-5", notice.kind === "error" ? "text-destructive-foreground" : "text-muted-foreground")}>{notice.kind}</span>
        <div className="min-w-0 flex-1">
          <Toast.Title className="line-clamp-2 break-words text-[13px] leading-5 font-normal text-foreground">{notice.text}</Toast.Title>
          <Toast.Description data-notice-when="" className="flex min-w-0 gap-3 font-mono text-[11px] leading-4 text-muted-foreground tabular-nums">
            {notice.where === undefined ? null : <span className="truncate">{notice.where}</span>}{" "}
            <span className="shrink-0">{clock(notice.at)}</span>
          </Toast.Description>
        </div>
        {action !== undefined ? (
          <Toast.Action
            data-notice-action=""
            render={<Button size="xs" variant="outline" className="shrink-0 font-mono" />}
            onClick={() => {
              action.run();
              useNotices.getState().dismiss(notice.id);
            }}
          >
            {action.word}
          </Toast.Action>
        ) : null}
        <Toast.Close render={<Button size="icon-xs" variant="ghost-muted" className="shrink-0" aria-label={CLOSE_NOTICE_LABEL} />}>
          <XIcon />
        </Toast.Close>
      </div>
    </Toast.Root>
  );
}

/** The notices store says which toasts stand; base-ui runs their timers, the pause on hover and the swipe. */
function NoticeStack() {
  const { toasts, add, close } = Toast.useToastManager<{ notice: NoticeRecord }>();
  const standing = useNotices(s => s.toasts);
  const added = useRef(new Set<string>());
  useEffect(() => {
    const { notices } = useNotices.getState();
    for (const id of standing) {
      const notice = notices.find(n => n.id === id);
      if (added.current.has(id) || notice === undefined) continue;
      added.current.add(id);
      add({ id, timeout: noticeTimeout(notice), data: { notice }, onClose: () => useNotices.getState().dismiss(id) });
    }
    for (const t of toasts) if (t.transitionStatus !== "ending" && !standing.includes(t.id)) close(t.id);
  }, [standing, toasts, add, close]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const newest = useNotices.getState().toasts.at(-1);
      if (event.key !== "Escape" || event.defaultPrevented || newest === undefined || ownsEscape(event.target)) return;
      event.preventDefault();
      useNotices.getState().dismiss(newest);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <Toast.Viewport data-notices="" className="pointer-events-none absolute top-2 right-3 z-[60] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 outline-none sm:right-5">
      {toasts.map(t => (
        <Notice key={t.id} toast={t} />
      ))}
    </Toast.Viewport>
  );
}

/** Mounted once, in the centre pane right under its header row. */
export function Notices() {
  return (
    <Toast.Provider limit={NOTICE_LIMIT}>
      <NoticeStack />
    </Toast.Provider>
  );
}
