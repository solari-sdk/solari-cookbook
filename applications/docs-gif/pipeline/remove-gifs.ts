import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";

const DOCS = "docs/docs";
const IMG = "docs/static/img";

for (const f of (await readdir(DOCS, { recursive: true })).filter((f) => f.endsWith(".md"))) {
  const path = `${DOCS}/${f}`;
  const text = await readFile(path, "utf8");
  const clean = text.replace(/\n*!\[[^\]]*\]\([^)]+\.gif\)\n?/g, "\n");
  if (clean !== text) {
    await writeFile(path, clean);
    console.error(`stripped ${path}`);
  }
}
for (const f of (await readdir(IMG, { recursive: true }).catch(() => [])).filter((f) => f.endsWith(".gif"))) {
  await rm(`${IMG}/${f}`);
  console.error(`deleted ${IMG}/${f}`);
}
spawnSync("find", [IMG, "-type", "d", "-empty", "-delete"]);
await rm("out", { recursive: true, force: true });
console.error("emptied out/");
await writeFile("app/tweaks.json", '{"status":"left","add":"right"}\n');
console.error("reset app/tweaks.json");
