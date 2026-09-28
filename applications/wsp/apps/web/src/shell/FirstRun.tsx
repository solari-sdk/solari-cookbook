// SPDX-License-Identifier: AGPL-3.0-only
// The whole window while this wsp holds no project: the one thing to do next and
// what it means, and the one key that does it. The form is the Add a project
// dialog's, so a project is made in one place whether this is the first or the
// tenth; a workspace is its own step after it.
import { Mark } from "../brand/Brand.js";
import { Button } from "../components/ui/button.js";
import { FIRST_RUN_WORDS } from "../sidebar/words.js";
import { requestAddProject } from "./shellRequests.js";

export function FirstRun() {
  return (
    <div data-k="first-run" className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-12 text-center">
      <Mark aria-hidden className="size-12 text-muted-foreground/40" />
      <h1 className="mt-6 text-base font-medium tracking-tight" data-k="title">
        {FIRST_RUN_WORDS.title}
      </h1>
      <p className="mt-1.5 max-w-xs text-sm text-muted-foreground" data-k="sentence">
        {FIRST_RUN_WORDS.sentence}
      </p>
      <Button type="button" data-k="add-project" className="mt-6" onClick={requestAddProject}>
        {FIRST_RUN_WORDS.add}
      </Button>
    </div>
  );
}
