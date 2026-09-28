// SPDX-License-Identifier: AGPL-3.0-only
// The mark and the lockup as inline SVG so they take the surrounding text
// colour; the .svg files beside this module carry the same paths for anything
// that cannot render React (the favicon, the desktop icons), and a test keeps
// the two in step.
import type { SVGProps } from "react";

export const MARK_PATH = "M1.6 8A3.4 3.4 0 0 1 8 8A3.4 3.4 0 0 0 14.4 8";

export const WORDMARK_PATHS: readonly string[] = [
  "M1 1L3.5 9L6 3L8.5 9L11 1",
  "M20.9 3A2.4 2 0 1 0 18.5 5A2.4 2 0 1 1 16.1 7",
  "M26 1V13M26 1H29A4 4 0 0 1 29 9H26",
];

/** The tilde alone, decorative: aria-hidden unless the caller overrides it. */
export function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      aria-hidden
      {...props}
    >
      <path d={MARK_PATH} />
    </svg>
  );
}

/** The tilde beside the wordmark, read as the word "wsp". */
export function Lockup(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 51 14"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="wsp"
      {...props}
    >
      <g transform="translate(0 -1.08) scale(0.76)" strokeWidth={3}>
        <path d={MARK_PATH} />
      </g>
      <g transform="translate(17 0)" strokeWidth={2}>
        {WORDMARK_PATHS.map(d => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
