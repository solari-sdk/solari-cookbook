// SPDX-License-Identifier: AGPL-3.0-only
// The composer's motion: the box eases to its content's height, the picker and
// action groups glide to where a layout switch puts them, and the draft is
// measured at the one-line width to decide when the box stops being one line.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export const COMPOSER_MOTION_MS = 180;
const EASE_OUT = "cubic-bezier(0.215, 0.61, 0.355, 1)";

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Sets the outer box's height to the inner's from a ResizeObserver, so the height transition runs without a render;
 * the first reading lands unanimated. */
export function useAnimatedHeight(outerRef: RefObject<HTMLElement | null>, innerRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (outer === null || inner === null) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      outer.style.height = `${inner.offsetHeight}px`;
      if (outer.dataset.armed === undefined && frame === 0) frame = requestAnimationFrame(() => (outer.dataset.armed = ""));
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [outerRef, innerRef]);
}

/** Glides every `[data-flip]` element under the root from where it stood before `key` changed to where it stands
 * after. The old positions are read during the render that carries the new key, while the DOM still shows the old
 * layout. */
export function useFlip(rootRef: RefObject<HTMLElement | null>, key: string): void {
  const committed = useRef(key);
  const before = useRef<Map<string, DOMRect> | null>(null);
  if (key !== committed.current && before.current === null && rootRef.current !== null) {
    before.current = new Map([...rootRef.current.querySelectorAll<HTMLElement>("[data-flip]")].map(el => [el.dataset.flip ?? "", el.getBoundingClientRect()]));
  }
  useLayoutEffect(() => {
    if (key === committed.current) return;
    committed.current = key;
    const from = before.current;
    before.current = null;
    const root = rootRef.current;
    if (from === null || root === null || reducedMotion()) return;
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip]")) {
      const was = from.get(el.dataset.flip ?? "");
      if (was === undefined) continue;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: COMPOSER_MOTION_MS, easing: EASE_OUT });
    }
  }, [key, rootRef]);
}

/** Whether the draft needs more than one line at the one-line layout's text width, read off a hidden mirror of the
 * text that always sits at that width, so switching layouts cannot flip the answer back. */
export function useTallDraft(mirrorRef: RefObject<HTMLElement | null>, text: string, enabled: boolean): boolean {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const mirror = mirrorRef.current;
    if (!enabled || mirror === null) {
      setTall(false);
      return;
    }
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(mirror).lineHeight);
      setTall(text.includes("\n") || mirror.offsetHeight > line * 1.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(mirror);
    return () => observer.disconnect();
  }, [enabled, mirrorRef, text]);
  return tall;
}
