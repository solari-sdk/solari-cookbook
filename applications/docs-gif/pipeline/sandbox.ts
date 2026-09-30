import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SandboxClient, type Sandbox } from "@solarisdk/sandbox";

// Fail before anything billable starts. .env.example says where each key comes from.
export function need(...keys: string[]) {
  for (const k of keys)
    if (!process.env[k]) {
      console.error(`error: ${k} is not set. Copy .env.example to .env and fill it in.`);
      process.exit(1);
    }
}
need("SOLARI_API_KEY");
export const client = new SandboxClient({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: "https://api.getsolari.com" });
export const ROOT = resolve(import.meta.dirname, "..");
// Guest commands run with no $HOME set, so paths are absolute.
export const DIR = "/root/solari-docs-gif";

let live: Sandbox | undefined;
// For the signal handler in index.ts: a stop signal skips every finally.
export const killLive = () => live?.kill();

export async function sh(sbx: Sandbox, script: string, cwd?: string) {
  const r = await sbx.commands.run("sh", { args: ["-c", `export HOME=/root PATH="/usr/local/bin:$PATH"; ${script}`], cwd, timeoutMs: 280_000 });
  if (r.exitCode) throw new Error(`\`${script}\` exited ${r.exitCode}\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export async function waitForApp(sbx: Sandbox) {
  const { url, token } = await sbx.previewUrl(3000);
  const headers: Record<string, string> = token ? { "x-pinetree-preview-token": token } : {};
  let status = 0;
  for (let i = 0; i < 60; i++) {
    status = await fetch(url, { headers }).then((r) => r.status, () => 0);
    if (status === 200) return { url, headers };
    await sleep(2000);
  }
  throw new Error(`preview link ${url} never returned 200 (last status ${status})`);
}

async function latestSnapshot() {
  const { snapshots } = await client.listSnapshots();
  const ours = snapshots.filter((s) => s.name?.startsWith("docs-gif-")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!ours[0]) throw new Error("no docs-gif snapshot on Solari, run `npm run snapshot` first");
  return ours[0].id;
}

export async function startApp() {
  const sbx = (live = await client.create({ template: "base", fromSnapshot: await latestSnapshot(), lifecycle: { onTimeout: "kill" } }));
  try {
    await sbx.connect(); // files.* go over the control socket, which create() leaves closed
    await sbx.files.write(`${DIR}/app/tweaks.json`, await readFile(`${ROOT}/app/tweaks.json`, "utf8"));
    return { ...(await waitForApp(sbx)), kill: () => sbx.kill() };
  } catch (e) {
    await sbx.kill();
    throw e;
  }
}
