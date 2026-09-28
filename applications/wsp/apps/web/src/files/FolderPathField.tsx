// SPDX-License-Identifier: AGPL-3.0-only
// The one field a folder is typed or pasted into, wherever the app asks a
// person for one: the composer's folder picker, and the import of a folder on
// this Mac. Enter reads the folder where the caller reads folders, and one
// that is not there is refused in the slot under the field, which stands at
// its two lines whether or not it holds a sentence, so nothing below it moves
// when a refusal arrives. The same slot holds the reason the keycap beside the
// field waits, in the muted ink, until a refusal takes it. A system chooser's result takes the same road as a
// typed path, so a folder the computer holding it will not read is refused in
// the one place with the one set of words, however it was named.
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import type { DaemonErrorCode } from "@wsp/protocol";
import { RefusalSlot } from "../settings/sheetParts.js";
import { FIELD, FIELD_LABEL } from "../settings/recipe/rows.js";
import { Input } from "../components/ui/input.js";
import { cn } from "../lib/utils.js";

/** A refusal in its two halves: what happened, then what to do about it. */
export interface FolderRefusal {
  readonly said: string;
  readonly fix: string;
}

/** What a folder the caller could not read is refused with. The path itself is never repeated: the field right
 * above the slot still holds it, and a path long enough to be mistyped is long enough to push the fix off the
 * slot's two lines. Each pair is written to wrap into those two lines at the narrowest slot it is drawn in, the
 * composer picker's 272 px, which is about 31 characters a line. */
export const FOLDER_PATH_WORDS = {
  notAbsolute: { said: "That is not a full path.", fix: "Start it with a slash." },
  notThere: { said: "No folder there.", fix: "Check the path, or walk to it below." },
  notAFolder: { said: "That is a file, not a folder.", fix: "Give the folder that holds it." },
  outside: { said: "Outside this task.", fix: "Import it as a project first." },
  unread: { said: "The task could not read it.", fix: "Walk to it below instead." },
} as const satisfies Record<string, FolderRefusal>;

const BY_CODE: Partial<Record<DaemonErrorCode, FolderRefusal>> = {
  "not-found": FOLDER_PATH_WORDS.notThere,
  "not-a-directory": FOLDER_PATH_WORDS.notAFolder,
  "outside-root": FOLDER_PATH_WORDS.outside,
};

/** The halves a daemon's typed refusal reads as; one it did not type reads as unread, since nothing more is known. */
export function folderPathRefusal(code: DaemonErrorCode | undefined): FolderRefusal {
  return (code === undefined ? undefined : BY_CODE[code]) ?? FOLDER_PATH_WORDS.unread;
}

/** The ghost a folder field wears. Never a path: a ghost shaped like one reads as the app naming a folder that is
 * there, so the first person to meet it typed it back and was refused for a folder wsp had made up. The one over a
 * list of folders names that road too, since walking is the other way to the same pick. */
export const FOLDER_GHOST = "type a folder";
export const FOLDER_GHOST_WITH_WALK = `${FOLDER_GHOST}, or walk below`;

export interface FolderPick {
  readonly path: string;
  /** The last path a read was started for; "" before the first one. This is the read's own mark: a caller compares
   * a newly typed path against it to know whether that path has already been asked about. */
  readonly applied: string;
  /** The last path a read answered for without refusing it, which is the folder anything drawn beside the field is
   * about; "" until one is. A browser follows this rather than the text or `applied`: a path still being read is not
   * yet known to be a folder, and walking to it moves the list under the hands of a person who is still typing. */
  readonly settled: string;
  readonly refusal: FolderRefusal | null;
  readonly reading: boolean;
  /** What is in the field; "" both clears it and drops the refusal, which is how a picker reopens empty. */
  readonly edit: (next: string) => void;
  /** Reads a path and picks it where it is a folder; a chooser's result comes through here too. */
  readonly submit: (path: string) => Promise<void>;
}

/** The typed path and what the last read of it said. `read` picks the folder and answers null, or answers the
 * halves it is refused with; a path that is not absolute is refused here, since a relative one would resolve
 * against a folder the person never typed. An answer lands only while the field still holds the path it is about,
 * so a slow read can neither write its refusal over a path typed after it nor move what is drawn beside the field
 * to a folder the person has already typed past. */
export function useFolderPick(read: (path: string) => Promise<FolderRefusal | null>): FolderPick {
  const [path, setPath] = useState("");
  const [applied, setApplied] = useState("");
  const [settled, setSettled] = useState("");
  const [refusal, setRefusal] = useState<FolderRefusal | null>(null);
  const [reading, setReading] = useState(false);
  const shown = useRef("");
  const edit = useCallback((next: string): void => {
    shown.current = next;
    setPath(next);
    setRefusal(null);
  }, []);
  const submit = useCallback(
    async (next: string): Promise<void> => {
      const folder = next.trim();
      shown.current = folder;
      setPath(folder);
      if (folder === "") return;
      setApplied(folder);
      if (!folder.startsWith("/")) {
        setRefusal(FOLDER_PATH_WORDS.notAbsolute);
        return;
      }
      setRefusal(null);
      setReading(true);
      try {
        const said = await read(folder);
        if (shown.current !== folder) return;
        setRefusal(said);
        if (said === null) setSettled(folder);
      } finally {
        setReading(false);
      }
    },
    [read],
  );
  return { path, applied, settled, refusal, reading, edit, submit };
}

/** The field, its label and the standing refusal slot under it. The keys are kept off whatever holds the field: a
 * menu reads typing as a jump to one of its rows and Enter as a press of the row it lands on, which would leave the
 * path half typed in a menu that has already closed. Escape is the exception, since it belongs to whatever holds the
 * field and nothing else there dismisses: a menu or a dialog closes on it, and a field that swallowed it left the
 * person with no key out. */
export function FolderPathField({ id, label, placeholder, hold, waiting, disabled, autoFocus, className }: {
  id: string;
  /** The field's own label; absent where what holds the field already names it, as a dialog's section does. */
  label?: string;
  placeholder: string;
  hold: FolderPick;
  /** Why the keycap beside this field cannot be pressed yet, in the slot's muted ink until a refusal takes the slot:
   * the one place a held keycap's reason is written, as every sheet with a held keycap writes it. */
  waiting?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const keyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") return;
    e.stopPropagation();
    if (e.key !== "Enter") return;
    e.preventDefault();
    void hold.submit(e.currentTarget.value);
  };
  return (
    <div data-k="folder-path-field" {...(hold.refusal === null ? {} : { "data-refused": "" })} className={cn("flex flex-col gap-2", className)}>
      {label === undefined ? null : (
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
      )}
      <Input
        id={id}
        data-k="folder-path"
        nativeInput
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        size="compact"
        className={cn(FIELD, "min-w-0")}
        placeholder={placeholder}
        value={hold.path}
        disabled={disabled}
        {...(hold.refusal === null ? {} : { "aria-invalid": true })}
        onChange={e => hold.edit(e.target.value)}
        onKeyDown={keyDown}
      />
      <RefusalSlot k="folder-path-refusal" {...(hold.refusal === null ? {} : hold.refusal)} {...(waiting === undefined ? {} : { waiting })} />
    </div>
  );
}
