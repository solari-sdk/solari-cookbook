/**
 * Standalone entry point. This is what runs inside the Solari sandbox:
 *   node server.js <port> [--fix]
 * No dependencies, no build, Node 18 compatible.
 */
import { createServer } from "node:http"
import { DEFAULT_BUGS, NO_BUGS, makeHandler } from "./site.js"

const port = Number(process.argv[2] || process.env.PORT || 8788)
const bugs = process.argv.includes("--fix") ? NO_BUGS : DEFAULT_BUGS
createServer(makeHandler(bugs)).listen(port, "0.0.0.0", () => {
  console.log(`demo site on :${port} (${bugs.leakExportToFree ? "with planted bugs" : "bugs fixed"})`)
})
