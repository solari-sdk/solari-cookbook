// The production adapters for the flow's ports: Rooms are Solari desktops, and
// the Grader runs the Hidden tests in a fresh Solari sandbox.
import type { Grader, Rooms } from "../flow.ts"
import { runHiddenTests } from "./grader.ts"
import { collectRoom, killRoom, openRoom, saveRecording, wakeRoom } from "./room.ts"

export const solariRooms: Rooms = {
  open: openRoom,
  collect: collectRoom,
  kill: killRoom,
  wake: wakeRoom,
  saveRecording,
}

export const solariGrader: Grader = { run: runHiddenTests }
