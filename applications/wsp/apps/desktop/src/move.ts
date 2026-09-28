// SPDX-License-Identifier: AGPL-3.0-only
// A downloaded mac app opened from anywhere but Applications is run
// translocated: macOS runs it from a read-only copy at a path that is new on
// every launch, so the wsp command the app writes names a path that is gone by
// the next one. Moving the bundle into Applications is what ends that, and
// Electron does the move and the relaunch itself.

export interface MoveGate {
  platform: NodeJS.Platform;
  /** A packaged bundle: a build tree run out of a checkout has nothing to move. */
  packaged: boolean;
  /** Electron's own answer for whether the bundle already sits in an Applications folder. */
  inApplications: boolean;
  /** The packaged smoke driving this launch: it runs the bundle out of dist on purpose and answers no dialog. */
  driven: boolean;
}

export function offersMove(gate: MoveGate): boolean {
  return gate.platform === "darwin" && gate.packaged && !gate.inApplications && !gate.driven;
}

export interface MovePrompt {
  type: "question";
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export const MOVE_PROMPT: MovePrompt = {
  type: "question",
  message: "Move wsp to your Applications folder?",
  detail: "Opened from anywhere else, macOS runs wsp from a copy whose path changes every launch, and the wsp command it writes for your agents stops working. wsp restarts itself once it has moved.",
  buttons: ["Move to Applications", "Not now"],
  defaultId: 0,
  cancelId: 1,
};

export interface MoveIO {
  /** Which button was pressed, by its place in the prompt's list. */
  ask: (prompt: MovePrompt) => Promise<number>;
  /** Electron's move: true means the app is on its way to Applications and this process is about to be replaced. */
  move: () => boolean;
  warn: (message: string) => void;
}

export type Moved = "not offered" | "declined" | "moving" | "failed";

/** Offers the move on the one launch shape that needs it and says what came of it. "moving" means the caller has
 * nothing left to do: Electron quits this process and starts the moved bundle. */
export async function offerMove(gate: MoveGate, io: MoveIO): Promise<Moved> {
  if (!offersMove(gate)) return "not offered";
  if ((await io.ask(MOVE_PROMPT)) !== MOVE_PROMPT.defaultId) return "declined";
  try {
    if (io.move()) return "moving";
    io.warn("wsp could not move itself to Applications; it keeps running where it is");
    return "failed";
  } catch (e) {
    io.warn(`wsp could not move itself to Applications: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
