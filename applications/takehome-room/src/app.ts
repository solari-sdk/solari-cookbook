// The production wiring, shared by the server, the command line and the scripts:
// the store in DATA_DIR, and the flow running on Solari.
import { config } from "./config.ts"
import { createFlow } from "./flow.ts"
import { solariGrader, solariRooms } from "./solari/index.ts"
import { createStore } from "./store.ts"
import { loadTask } from "./tasks.ts"

export const store = createStore(config.dataDir)

export const flow = createFlow({
  store,
  rooms: solariRooms,
  grader: solariGrader,
  loadTask,
  limits: config.limits,
})
