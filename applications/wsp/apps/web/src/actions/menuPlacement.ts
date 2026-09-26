// SPDX-License-Identifier: AGPL-3.0-only
// Where the in-app menu opens: at the pointer, flipped to the other side of
// it when that edge of the viewport is too near, and never past the margin.

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

const MARGIN = 8;

export function placeMenu(pointer: Point, menu: Size, viewport: Size): { left: number; top: number } {
  const fitsRight = pointer.x + menu.width <= viewport.width - MARGIN;
  const fitsBelow = pointer.y + menu.height <= viewport.height - MARGIN;
  const left = fitsRight ? pointer.x : pointer.x - menu.width;
  const top = fitsBelow ? pointer.y : pointer.y - menu.height;
  return {
    left: Math.max(MARGIN, Math.min(left, viewport.width - menu.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, viewport.height - menu.height - MARGIN)),
  };
}
