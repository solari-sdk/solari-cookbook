import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import express from "express";
import { createServer } from "vite";
import { z } from "zod";

const Pos = z.enum(["left", "middle", "right"]);
const Tweaks = z.object({
  status: Pos,
  add: Pos,
});
export type Tweaks = z.infer<typeof Tweaks>;
const ROOT = resolve(import.meta.dirname, ".."); // no "..", which sendFile refuses
const APP = ROOT + "/app";
const FILE = APP + "/tweaks.json";
const DOCS = ROOT + "/docs/docs/how-to";

const NAMES: Record<keyof Tweaks, string> = { status: "\\*\\*Status\\*\\*", add: "\\*\\*Add Task\\*\\*" };
const PHRASE: Record<Tweaks["status"], string> = { left: "on the left", middle: "in the middle", right: "on the right" };
async function syncDocs(t: Tweaks) {
  for (const f of (await readdir(DOCS)).filter((f) => f.endsWith(".md"))) {
    const path = `${DOCS}/${f}`;
    const was = await readFile(path, "utf8");
    let text = was;
    for (const key of Object.keys(NAMES) as (keyof Tweaks)[])
      text = text.replace(new RegExp(`(${NAMES[key]}[^.\\n]*?)(on the left|in the middle|on the right)`, "g"), `$1${PHRASE[t[key]]}`);
    if (text !== was) await writeFile(path, text);
  }
}

const app = express();
const server = createHttpServer(app);

app.get("/api/tweaks", (_req, res) => res.sendFile(FILE));

let updating = false;
app.post("/api/tweaks", express.json({ type: "*/*" }), async (req, res) => {
  const t = Tweaks.parse(req.body);
  if (updating) return void res.status(409).send("already updating");
  updating = true;
  await writeFile(FILE, JSON.stringify(t) + "\n");
  await syncDocs(t);
  const proc = spawn("node", ["--env-file-if-exists=.env", "pipeline/update.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" }, // the panel matches on plain lines
  });
  res.type("text/plain");
  proc.stderr.pipe(res, { end: false });
  proc.on("close", (code) => {
    updating = false;
    res.end(`\nexit ${code}\n`);
  });
});

const vite = await createServer({
  root: APP,
  configFile: false,
  plugins: [tailwindcss()],
  resolve: { alias: { "@": APP } },
  server: { middlewareMode: true, hmr: { server }, allowedHosts: true, warmup: { clientFiles: ["./app.tsx"] } },
});
app.use(vite.middlewares);

server.listen(3000, () => console.log("app on http://localhost:3000"));
