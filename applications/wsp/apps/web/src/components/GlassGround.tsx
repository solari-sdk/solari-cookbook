// SPDX-License-Identifier: AGPL-3.0-only

/** The filter the glass recipe names as --glass-ground: the page's own background laid under whatever it filters.
 * CSS filters reach an SVG filter only by an id in the same document, so it lives in the page once. */
export function GlassGround() {
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <filter id="glass-ground" x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
        <feFlood className="[flood-color:var(--background)]" />
        <feComposite in="SourceGraphic" operator="over" />
      </filter>
    </svg>
  );
}
