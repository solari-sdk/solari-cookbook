/**
 * Form delivery check — an HTTP 200 is not a delivered lead.
 *
 * A contact form can accept a submission, answer 200, and show a thank-you page
 * while the message goes nowhere: a destination address that was never
 * configured, a sender identity that failed verification, a spam gate that
 * quietly swallows what it does not like. Uptime checks call all of that
 * healthy, because the page really does load.
 *
 * The only way to know is to submit like a visitor and then ask, separately,
 * whether the lead arrived. That takes two products at once — a cloud browser
 * to drive the form, and a sandbox to host the destination on a public URL,
 * because the browser runs on Solari's infrastructure and cannot reach a sink
 * on your laptop.
 *
 * The sandbox serves two routes that are identical to a visitor. /deliver
 * records the lead. /drop throws it away and says thank you anyway.
 */
import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"

const apiKey = process.env.SOLARI_API_KEY!
const PORT = 3000

const SERVER = `
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

SEEN = set()

FORM = """<!doctype html><meta charset="utf-8">
<form method="post">
  <input name="email">
  <textarea name="message"></textarea>
  <button type="submit">Send</button>
</form>"""

class Handler(BaseHTTPRequestHandler):
    def reply(self, body):
        raw = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parts = urlparse(self.path)
        if parts.path == "/seen":
            token = (parse_qs(parts.query).get("token") or [""])[0]
            self.reply("yes" if token in SEEN else "no")
        else:
            self.reply(FORM)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        # /deliver keeps the lead. /drop is the whole point of this example.
        if urlparse(self.path).path == "/deliver":
            SEEN.update(re.findall(r"LEAD-[0-9]+", body))
        self.reply("Thanks, we got your message")

    def log_message(self, *args):
        pass

HTTPServer(("0.0.0.0", PORTNUM), Handler).serve_forever()
`.replace("PORTNUM", String(PORT))

const client = new SolariClient({ apiKey })
const solari = new Solari({ apiKey })
const sandbox = await client.sandboxes.create({
  template: "base",
  timeoutMs: 5 * 60_000,
})

try {
  await sandbox.connect()
  await sandbox.files.write("/tmp/server.py", SERVER)

  // Background it with an explicit `sh -c`: commands are not shell-interpreted,
  // and `run` waits for the process to exit, so a foreground server would block
  // until the idle timeout.
  await sandbox.commands.run("sh", {
    args: ["-c", "nohup python3 /tmp/server.py >/dev/null 2>&1 &"],
  })

  const { url } = await sandbox.previewUrl(PORT)

  // `previewUrl` hands back an address that already carries a `?pt_token=`
  // query string. Concatenating "/drop" onto it puts the path *after* the
  // query and every request 404s, so build paths through URL.
  const at = (path: string, token?: string) => {
    const u = new URL(url)
    u.pathname = path
    if (token) u.searchParams.set("token", token)
    return u.toString()
  }

  await waitForServer(at("/deliver"))

  for (const route of ["/deliver", "/drop"]) {
    const token = `LEAD-${Date.now()}`
    const browser = await solari.launch()
    try {
      const page = await browser.newPage()
      await page.goto(at(route))
      await page.fill('input[name="email"]', "audit@example.com")
      await page.fill('textarea[name="message"]', token)
      await page.click("button")
      await page.waitForTimeout(2000)

      const said = (await page.innerText("body")).trim()
      const arrived =
        (await (await fetch(at("/seen", token))).text()).trim() === "yes"

      console.log(`${route.padEnd(9)} says "${said}" | lead arrived: ${arrived}`)
    } finally {
      await browser.close()
    }
  }
} finally {
  // `kill()`, not `close()`, ends the VM. Nested so a failing kill cannot skip
  // the close: the browser client owns a listening loopback proxy, so missing
  // `solari.close()` leaves the process alive forever instead of exiting.
  try {
    await sandbox.kill()
  } finally {
    await solari.close()
  }
}

async function waitForServer(target: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      if ((await fetch(target)).ok) return
    } catch {
      // preview routing is not up yet
    }
  }
  throw new Error(`server never came up at ${target}`)
}
