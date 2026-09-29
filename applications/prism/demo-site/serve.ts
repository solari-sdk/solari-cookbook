/**
 * Serves the demo app on a real port over real HTTP, so the browser performs an
 * actual navigation. Never `setContent()` of an inline string: a cloud browser
 * that only renders strings is not doing anything a local one would not.
 *
 * The handler itself comes from `site.js`, which is also what the sandbox runs.
 */
import { createServer, type Server } from "node:http"
import { DEFAULT_BUGS, makeHandler, type Bugs } from "./app.js"

export type DemoSite = { url: string; close: () => Promise<void> }

export async function serve(port = 0, bugs: Bugs = DEFAULT_BUGS): Promise<DemoSite> {
  const server: Server = createServer(makeHandler(bugs))
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r))
  const addr = server.address()
  if (typeof addr === "string" || addr === null) throw new Error("no port")
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () =>
      new Promise((r) => {
        // Browsers hold the connection open with keep-alive, and `close()`
        // waits for existing sockets to drain -- so without this the process
        // prints its report and then hangs forever.
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = await serve(Number(process.env.PORT ?? 8788))
  console.log(`demo site on ${site.url}`)
}
