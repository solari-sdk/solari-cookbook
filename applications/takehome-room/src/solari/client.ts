// One pair of Solari clients for the process, created on first use, so a missing
// key fails with a clear message at the first call instead of at import.
import { DesktopClient } from "@solarisdk/desktop"
import { SandboxClient } from "@solarisdk/sandbox"

const BASE_URL = "https://api.getsolari.com"

function apiKey(): string {
  const key = process.env.SOLARI_API_KEY
  if (!key) throw new Error("SOLARI_API_KEY is not set. Copy .env.example to .env and add your key.")
  return key
}

let desktopClient: DesktopClient | undefined
let sandboxClient: SandboxClient | undefined

export const desktops = (): DesktopClient => (desktopClient ??= new DesktopClient({ apiKey: apiKey(), baseUrl: BASE_URL }))

/** Also manages desktops: list() and kill() work on them by id. */
export const sandboxes = (): SandboxClient => (sandboxClient ??= new SandboxClient({ apiKey: apiKey(), baseUrl: BASE_URL }))
