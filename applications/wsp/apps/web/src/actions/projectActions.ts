// SPDX-License-Identifier: AGPL-3.0-only
// The project's actions, one registry: what a project's header row in the
// sidebar and the palette offer for one project. A project is where a piece of
// work starts and what a workspace is made of; nothing here touches a machine.
import { PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { projectInUseRefusal } from "@wsp/protocol";
import { NEW_WORKSPACE, PROJECT_WORDS } from "../sidebar/words.js";
import type { ActionEntry } from "./registry.js";

/** What the enabled rules read: the project and the workspaces standing on it, which is what its removal is
 * refused for, in the runtime's own sentence. */
export interface ProjectTarget {
  readonly id: string;
  readonly name: string;
  readonly workspaces: ReadonlyArray<string>;
}

export interface ProjectVerbs {
  /** Opens the dialog that asks the one question, with this project picked. */
  readonly newWorkspace: (projectId: string) => void;
  /** Opens the project's own page in Settings. */
  readonly openSettings: (projectId: string) => void;
  /** Forgets the project; absent on a client whose host cannot, and the row says so. */
  readonly removeProject?: ((projectId: string) => void) | undefined;
}

/** What the app says when its own client cannot forget a project, in place of a row that would ask nobody. */
export const CLIENT_CANNOT_REMOVE_PROJECT = "This wsp cannot remove a project from here.";

export const projectActions: ReadonlyArray<ActionEntry<ProjectTarget, ProjectVerbs>> = [
  {
    id: "new-workspace",
    group: "open",
    icon: () => PlusIcon,
    searchTerms: ["new task", "new piece of work", "start work"],
    title: () => NEW_WORKSPACE,
    rowLabel: target => `${NEW_WORKSPACE} on ${target.name}`,
    refusal: () => null,
    run: (target, verbs) => verbs.newWorkspace(target.id),
  },
  {
    id: "project-settings",
    group: "open",
    icon: () => SettingsIcon,
    searchTerms: ["project settings", "project icon", "project colour", "project color"],
    title: () => PROJECT_WORDS.settings,
    rowLabel: target => `${PROJECT_WORDS.settings} for ${target.name}`,
    refusal: () => null,
    run: (target, verbs) => verbs.openSettings(target.id),
  },
  {
    id: "remove-project",
    group: "remove",
    icon: () => Trash2Icon,
    destructive: true,
    searchTerms: ["remove project", "forget project"],
    title: () => PROJECT_WORDS.remove,
    rowLabel: target => `${PROJECT_WORDS.remove} ${target.name}`,
    // The runtime refuses a project a workspace stands on and names them; the row says that sentence before the
    // click rather than after it.
    refusal: (target, verbs) =>
      target.workspaces.length > 0 ? projectInUseRefusal(target.name, target.workspaces) : verbs.removeProject === undefined ? CLIENT_CANNOT_REMOVE_PROJECT : null,
    run: (target, verbs) => verbs.removeProject?.(target.id),
  },
];
