// SPDX-License-Identifier: AGPL-3.0-only
// What every reader of a project's own files hands back, and the one shape a
// reader takes. A reader knows one kind of manifest and none of the catalog's
// rows; the one catalog word it may say is the road its own ecosystem installs
// by. Naming the row a finding lands on is the scan's job, once.
import type { RoadName } from "@wsp/catalog";

/** One tool a project's own files ask for. */
export interface ProjectFinding {
  /** The word the file used: a command, a package name, a language, a manager. */
  name: string;
  /** That word as the file's own ecosystem writes it, for a finding the catalog has no name for. */
  label: string;
  /** The line the row shows, naming the file that asked and what it said. */
  why: string;
  /** Evidence only where the catalog already carries the name: a word read off a command line names a project's own
   * dependency as often as a tool the machine installs, so it never stands up a custom row of its own. */
  catalogOnly?: true;
  /** The road the project's own install puts this package on the machine by. Such a finding lands only on a row that
   * names the package as meaning it: the project installs the package itself, so a row is a need only when it puts
   * more than the package on the machine (a browser). */
  installs?: RoadName;
}

/** A file handed to a reader. */
export interface ProjectFile {
  /** Relative to the project folder, slash-separated. */
  path: string;
  text: string;
}

/** One kind of project manifest, read into the tools it names. Adding a kind is one module here and its entry in PROJECT_READERS. */
export interface ProjectReader {
  id: string;
  /** Paths under the project folder this reader is given, in the order it wants them; a name ending in a slash is
   * every file directly under that folder, and a `*` segment is every folder at that depth. */
  files: readonly string[];
  /** Whether the reader wants the bytes or only that the file is there: a lockfile runs to megabytes and one of them
   * is not text at all, so a reader that reads nothing out of it is handed an empty text. */
  reads: "text" | "presence";
  read(file: ProjectFile): readonly ProjectFinding[];
}
