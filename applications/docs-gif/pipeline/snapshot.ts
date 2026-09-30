import { execFileSync } from "node:child_process";
import type { Sandbox } from "@solarisdk/sandbox";
import { client, DIR, ROOT, sh, waitForApp } from "./sandbox.ts";

const FILES = ["package.json", "tsconfig.json", "docs/package.json", "pipeline/package.json", "pipeline/serve.ts", "app"];

async function upload(sbx: Sandbox) {
  const tar = ["-czf", "-", "--format", "ustar", "--exclude", "node_modules", "-C", ROOT, ...FILES];
  // COPYFILE_DISABLE keeps macOS resource forks out of the tarball; GNU tar ignores it.
  await sbx.files.upload("/tmp/src.tgz", execFileSync("tar", tar, { env: { ...process.env, COPYFILE_DISABLE: "1" } }));
  await sh(sbx, `mkdir -p ${DIR} && tar -xzf /tmp/src.tgz -C ${DIR}`);
}

// `npm run snapshot`: builds a snapshot from the files on this machine, then deletes the older ones.
const name = `docs-gif-${Date.now()}`;
console.error(`building snapshot ${name}, takes a few minutes`);
const sbx = await client.create({ template: "base", lifecycle: { onTimeout: "kill" } });
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, async () => {
    await sbx.kill().catch(() => {});
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
let id: string;
try {
  await sbx.connect(); // files.* go over the control socket, which create() leaves closed
  const node = `node-${process.version}-linux-x64`;
  await sh(sbx, `curl -fsSL https://nodejs.org/dist/${process.version}/${node}.tar.gz | tar -xz -C /usr/local --strip-components=1`);
  await upload(sbx);
  // Skips docs/: the sandbox never serves the docs site. No lockfile: the cookbook ignores them, so install, not ci.
  await sh(sbx, "npm install -w app -w pipeline", DIR);
  // setsid + nohup so the server outlives this one-shot command.
  await sh(sbx, "setsid nohup node serve.ts > /tmp/app.log 2>&1 < /dev/null &", `${DIR}/pipeline`);
  await waitForApp(sbx).catch(async (e) => {
    console.error(await sh(sbx, "tail -20 /tmp/app.log; true"));
    throw e;
  });
  id = await sbx.snapshot(name);
} finally {
  await sbx.kill();
}
for (const s of (await client.listSnapshots()).snapshots)
  if (s.id !== id && s.name?.startsWith("docs-gif-"))
    await client.deleteSnapshot(s.id).catch((e) => console.error(`old snapshot ${s.id} not deleted: ${e.message}`));
console.error(`snapshot ${name} ready`);
