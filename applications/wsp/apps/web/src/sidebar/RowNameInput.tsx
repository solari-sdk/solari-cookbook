// SPDX-License-Identifier: AGPL-3.0-only
// The one name box the sidebar's rows share: a workspace row's name and a
// thread row's title become this field in their own slot, in the slot's own
// font and size, so the row keeps its height and its grammar while a name is
// typed. The name it had is selected, so typing replaces it. Enter names the
// row, Escape and leaving it cancel, and a name that is blank or unchanged is
// a cancel too. Keys stop here rather than reaching the sidebar's own
// traversal, which reads Home and End. While the name is on its way the field
// stays as it is and neither Enter nor leaving it does anything, so a save
// that takes seconds cannot lose what was typed.
import { useEffect, useRef, type KeyboardEvent } from "react";

export function RowNameInput({
  name,
  label,
  saving,
  onRename,
  onCancel,
}: {
  name: string;
  /** What the field is called: the row's own rename action, as the menu shows it. */
  label: string;
  /** That name is on its way to the runtime: the field stays exactly as it is and takes no second Enter. */
  saving: boolean;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    if (saving) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const typed = event.currentTarget.value.trim();
    if (typed === "" || typed === name) onCancel();
    else onRename(typed);
  };
  return (
    <input
      ref={ref}
      data-row-name-input
      aria-label={label}
      defaultValue={name}
      spellCheck={false}
      className="min-w-0 flex-1 rounded-sm border border-input bg-transparent px-1 text-inherit outline-hidden transition-[border-color] duration-150 focus:border-ring"
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (!saving) onCancel();
      }}
    />
  );
}
