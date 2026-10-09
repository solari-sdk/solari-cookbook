// pnpm run sweep: kill Rooms this app left running.
//
// A Room should die when its Interview ends, but in testing a desktop that had
// been paused sometimes came back after a kill. On the free plan one leftover
// holds the only slot, and every new Room or grading run fails with
// "Too many concurrent sessions".
//
// This kills a tagged desktop only when its Interview is in this DATA_DIR and has
// already ended. A desktop whose Interview it cannot find is only listed: it may
// belong to another copy of the app, or to a different DATA_DIR. Other machines
// on the account are never touched.
import { store } from "../src/app.ts"
import { sandboxes } from "../src/solari/client.ts"

const ended = new Set(["collecting", "grading", "done", "failed"])

let killed = 0
let unknown = 0
for await (const s of sandboxes().listAll({ metadata: { app: "takehome-room" } })) {
  if (s.state === "gone") continue
  const id = s.metadata.interview ?? ""
  const iv = id ? store.load(id) : undefined
  if (!iv) {
    unknown++
    console.log(`skip  ${id || "(untagged)"} (${s.state}): no such Interview in this DATA_DIR`)
  } else if (!ended.has(iv.phase)) {
    console.log(`keep  ${id}: its Interview is ${iv.phase}`)
  } else {
    await sandboxes().kill(s.sandboxId)
    killed++
    console.log(`kill  ${id} (${s.state}): its Interview is ${iv.phase}`)
  }
}
console.log(killed ? `Killed ${killed}. Run again in a minute to check none came back.` : "Killed none.")
if (unknown) console.log(`${unknown} desktop(s) skipped. Kill them in the Solari console if you are sure they are leftovers.`)
