// Live end-to-end run against Solari, with this script playing the Candidate:
// open the Room, write a solution and commit it, Start, Submit, and wait for the
// Report. Costs a few cents of credit (one desktop for ~3 min, one sandbox for ~1 min).
//
//   pnpm run e2e            a correct solution: expect 9 / 9
//   pnpm run e2e broken  a solution with an off-by-one in expiry: expect fewer
//   pnpm run e2e paused  pause the Room before Submit: collecting must resume it
import { flow, store } from "../src/app.ts"
import { config } from "../src/config.ts"
import type { Interview } from "../src/interview.ts"
import { desktops } from "../src/solari/client.ts"

const broken = process.argv[2] === "broken"
const paused = process.argv[2] === "paused"

const SOLUTION = `import time
from collections import OrderedDict


class LRUCache:
    def __init__(self, capacity, ttl_seconds=None, clock=time.monotonic):
        self.capacity, self.ttl, self.clock = capacity, ttl_seconds, clock
        self.items = OrderedDict()

    def _expired(self, stamp):
        return self.ttl is not None and self.clock() - stamp ${broken ? ">" : ">="} self.ttl

    def get(self, key):
        if key not in self.items:
            return None
        value, stamp = self.items[key]
        if self._expired(stamp):
            del self.items[key]
            return None
        self.items.move_to_end(key)
        return value

    def put(self, key, value):
        self.items.pop(key, None)
        if len(self.items) >= self.capacity:
            self.items.popitem(last=False)
        self.items[key] = (value, self.clock())

    def __len__(self):
        return sum(1 for _, stamp in self.items.values() if not self._expired(stamp))
`

async function waitFor(id: string, phases: string[], timeoutMs: number): Promise<Interview> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const iv = store.load(id)!
    if (phases.includes(iv.phase)) return iv
    if (iv.phase === "failed") throw new Error(`Interview failed: ${iv.error}`)
    if (Date.now() > until) throw new Error(`Still ${iv.phase} after ${timeoutMs / 1000} s`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

const t0 = Date.now()
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`

const iv = flow.create("lru-cache", { workMinutes: 10, setupMinutes: 5 })
console.log(`[${secs()}] Interview ${iv.id} created`)
flow.open(iv.id)
const opened = await waitFor(iv.id, ["setup"], 120_000)
console.log(`[${secs()}] Room open, recording: ${opened.recordingUrl ? "yes" : "no"}`)

// Play the Candidate through a second control channel to the same desktop.
const room = await desktops().connect(opened.roomId!)
await room.connect()
const asCandidate = (script: string) =>
  room.exec("sh", { args: ["-c", `runuser -l desktop -c ${JSON.stringify(script)}`] })

flow.start(iv.id)
console.log(`[${secs()}] clock started`)
await room.fs.write("/home/desktop/task/cache.py", SOLUTION)
await room.exec("sh", { args: ["-c", "chown desktop:desktop /home/desktop/task/cache.py"] })
const visible = await asCandidate("cd ~/task && python3 -m unittest discover -s tests 2>&1 | tail -1")
console.log(`[${secs()}] visible tests in the Room: ${visible.stdout.trim()}`)
const commit = await asCandidate("cd ~/task && git add -A && git commit -qm 'Implement LRUCache with TTL' && git log --oneline | head -1")
console.log(`[${secs()}] committed: ${commit.stdout.trim() || commit.stderr.trim()}`)
if (paused) {
  // As if the Candidate's laptop slept until the Room's idle timeout.
  await room.pause()
  console.log(`[${secs()}] Room paused: ${(await desktops().get(opened.roomId!)).status}`)
}
room.close()

flow.end(iv.id, "submitted")
console.log(`[${secs()}] submitted, collecting and grading…`)
const done = await waitFor(iv.id, ["done"], 300_000)
console.log(`[${secs()}] done: ${done.grade!.passed} / ${done.grade!.total} hidden tests passed`)
console.log(`commits:\n${done.gitLog}`)
console.log(`artifacts: data/artifacts/${iv.id}/`)
console.log(`Report (with the server running): ${config.publicUrl}/r/${done.reviewerToken}`)
process.exit(0)
