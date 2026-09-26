// SPDX-License-Identifier: AGPL-3.0-only
// The recipe this computer holds, planned for a computer somebody owns. The
// rows are read the way a copy of the image at another place reads them, since
// a box is provisioned from the same recipe by the same roads: this computer
// as it is now with the recipe written over it, every sign-in left to the
// vault, and no Keychain read at all. What runs the plan is the engine's; what
// is here is where the recipe lives and what this computer is.
import { existsSync } from "node:fs";
import type { Manifest, Platform } from "@wsp/collect";
import { agentStateFile, provisionBox, provisionPlanOf, type BrewTable } from "@wsp/engine";
import { probePath } from "@wsp/protocol";
import { TOOL_PREFIX } from "@wsp/catalog";
import type { PlaceProvisioner } from "@wsp/runtime";
import { serverVault } from "./env-keys.js";
import { brewTableFor, copyRows, planImport } from "./image-recipe.js";
import { loadRecipe, smallRecipePath } from "./recipe-file.js";

/** What the planner reads beside the recipe: this computer's rungs and its Homebrew table, the same two readers
 * wsp init and a copy's build take. */
export interface ProvisionReaders {
  statePath: string;
  home: string;
  platform: Platform;
  collect(): Promise<Manifest>;
  brew(): Promise<BrewTable>;
}

/** The host's side of the recipe job: the plan off the recipe beside its state file, and the run the engine does
 * on the computer itself. A computer with no recipe here is answered with the path one would be written to, which
 * is what the join and the update say rather than installing nothing quietly. */
export function placeProvisioner(o: ProvisionReaders): PlaceProvisioner {
  return {
    async plan(on) {
      const recipePath = smallRecipePath(o.statePath);
      if (!existsSync(recipePath)) return { noRecipe: recipePath };
      const recipe = loadRecipe(recipePath);
      const manifest = await o.collect();
      const brew = await brewTableFor(manifest, o.brew);
      // No record and so no pins: a computer somebody owns keeps no sealed version, and the catalog's own
      // versions are what its rows install at.
      const rows = copyRows(manifest, { recipe, pins: [] }, { home: o.home, brew });
      // The one PATH every script of this job exports on that computer: its own system directories, with every
      // directory under the home it shares with the workspaces on it left out, since a process inside one of them
      // writes there and the job runs as root outside them.
      const path = probePath(on.home);
      // And the folder every manager installs under there: wsp's own under /opt, which that list holds through
      // /usr/local/bin and no workspace on that computer can write. Nothing of the job lands under the home.
      const prefix = TOOL_PREFIX;
      const imp = planImport(
        rows.filter(e => e.bring === true),
        // The files that travel to a computer somebody owns are the agents' own: their skills, their standing
        // instructions and their configuration, in the agents' homes there. A dotfile, a login's store and a
        // shell's rc are the person's computer, and the computer they joined is one they already live on.
        { rows, small: recipe, home: o.home, platform: o.platform, brew, secrets: new Map(), vault: serverVault(o.statePath), keepFile: agentStateFile, path, prefix },
      );
      return provisionPlanOf(imp, recipe.at, path, prefix);
    },
    run: (machine, plan, stage, on) => provisionBox(machine, plan, stage, on),
  };
}
