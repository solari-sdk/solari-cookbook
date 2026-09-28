// SPDX-License-Identifier: AGPL-3.0-only
// The in-app context menu a browser tab gets: the app's tooltip skin (a
// hairline, the popover tier, no arrow), opened at the pointer and kept inside
// the viewport, one row per item with its chord at the right edge, disabled
// rows dimmed with their refusal as the tooltip. Arrows walk every row so a
// refusal can be read, Enter and Space run the focused one, Escape, Tab, a
// press outside, a scroll or a resize close it, and focus goes back where it
// was. Mounted once by the shell.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ContextMenuItem } from "@wsp/protocol";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { useContextMenuStore, type OpenMenu } from "./contextMenu.js";
import { placeMenu } from "./menuPlacement.js";

export function ContextMenuHost() {
  const menu = useContextMenuStore(s => s.menu);
  return menu === null ? null : <InAppContextMenu key={menu.seq} menu={menu} />;
}

const ROW_CLASS = "flex min-h-7 w-full cursor-pointer select-none items-center gap-3 rounded-sm px-2 py-1 text-left text-xs text-popover-foreground outline-none focus:bg-accent focus:text-accent-foreground hover:bg-accent hover:text-accent-foreground";

function InAppContextMenu({ menu }: { menu: OpenMenu }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ left: menu.at.x, top: menu.at.y });
  const [focused, setFocused] = useState(() => Math.max(0, menu.items.findIndex(item => item.enabled)));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlacement(placeMenu(menu.at, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [menu.at]);

  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[focused]?.focus({ preventScroll: true });
  }, [focused, menu]);

  useEffect(() => {
    const dismiss = () => menu.choose(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  const count = menu.items.length;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        setFocused(i => (i + 1) % count);
        break;
      case "ArrowUp":
        setFocused(i => (i - 1 + count) % count);
        break;
      case "Home":
        setFocused(0);
        break;
      case "End":
        setFocused(count - 1);
        break;
      case "Enter":
      case " ": {
        const item = menu.items[focused];
        if (item?.enabled) menu.choose(item.id);
        break;
      }
      case "Escape":
      case "Tab":
        menu.choose(null);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="menu"
      data-context-menu
      tabIndex={-1}
      style={{ position: "fixed", left: `${placement.left}px`, top: `${placement.top}px` }}
      className="z-[130] min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md/5 outline-none not-dark:bg-clip-padding"
      onKeyDown={onKeyDown}
      onContextMenu={event => event.preventDefault()}
    >
      {menu.items.map((item, index) => (
        <MenuRow key={item.id} item={item} startsGroup={index > 0 && menu.items[index - 1]!.group !== item.group} onFocus={() => setFocused(index)} onChoose={() => menu.choose(item.id)} />
      ))}
    </div>
  );
}

function MenuRow({ item, startsGroup, onFocus, onChoose }: { item: ContextMenuItem; startsGroup: boolean; onFocus: () => void; onChoose: () => void }) {
  const row = (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={item.enabled ? undefined : true}
      className={cn(ROW_CLASS, !item.enabled && "cursor-default opacity-50 hover:bg-transparent hover:text-popover-foreground focus:bg-accent/50", item.enabled && item.destructive && "text-destructive-foreground")}
      onFocus={onFocus}
      onClick={() => {
        if (item.enabled) onChoose();
      }}
    >
      <span data-menu-label className="min-w-0 flex-1 truncate">
        {item.label}
      </span>
      {item.shortcut !== undefined ? <kbd className="ms-auto font-sans text-[10px] tracking-wide text-muted-foreground">{item.shortcut}</kbd> : null}
    </button>
  );
  return (
    <>
      {startsGroup ? <div role="separator" className="mx-2 my-1 h-px bg-border" /> : null}
      {item.refusal === undefined ? (
        row
      ) : (
        <Tooltip>
          <TooltipTrigger render={row} />
          <TooltipPopup side="right">{item.refusal}</TooltipPopup>
        </Tooltip>
      )}
    </>
  );
}
