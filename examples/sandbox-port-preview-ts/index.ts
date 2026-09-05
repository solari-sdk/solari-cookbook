/**
 * Port preview — expose a server running inside the sandbox on a public URL.
 *
 * Handy for previewing something an agent just built: start the dev server in
 * the VM, hand the URL to a human (or fetch it yourself). The URL is served
 * from *.preview.getsolari.com and is reachable from the open internet.
 */
import { SolariClient } from "@solarisdk/sdk"

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
const PORT = 3000

const sandbox = await pt.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 })
try {
  await sandbox.connect()

  await sandbox.files.write(
    "/tmp/site/index.html",
    "<h1>Served from inside a Solari sandbox</h1>\n",
  )

  // Background it with a shell — `commands.run` waits for the process to exit,
  // so running a server in the foreground would block until the idle timeout.
  await sandbox.commands.run("sh", {
    args: ["-c", `cd /tmp/site && nohup python3 -m http.server ${PORT} >/dev/null 2>&1 &`],
  })

  const { url } = await sandbox.previewUrl(PORT)
  console.log("preview:", url)

  // The URL carries a ?pt_token=… the gateway authenticates with, so reach for a
  // path with `new URL()` rather than string concatenation:
  //   const page = new URL(url); page.pathname = "/about"; fetch(page)
  // `${url}/about` puts "/about" inside the query string and returns 401.

  // Prove it's really public: fetch it from *here*, outside the VM.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const res = await fetch(url)
    if (res.ok) {
      console.log("fetched:", (await res.text()).trim())
      break
    }
    console.log(`  waiting for the server (HTTP ${res.status})`)
  }
} finally {
  await sandbox.kill()
}
