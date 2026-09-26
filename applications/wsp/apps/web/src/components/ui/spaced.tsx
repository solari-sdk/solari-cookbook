// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, type ReactNode } from "react";

/** Facts on one line held apart by space alone, never a dot between them. Inline, so a truncating parent still cuts
 * the line at its edge; a real space sits between them so copied text and a screen reader keep the words apart. */
export function Spaced({ parts }: { parts: ReadonlyArray<ReactNode> }) {
  return (
    <>
      {parts.map((part, at) => (
        <Fragment key={at}>
          {at === 0 ? null : " "}
          <span className={at === 0 ? undefined : "ms-2"}>{part}</span>
        </Fragment>
      ))}
    </>
  );
}
