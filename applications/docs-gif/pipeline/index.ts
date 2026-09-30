import { appendFileSync, renameSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { openBrowser } from "./browser.ts";
import { CURSOR, toGif, type Frame } from "./gif.ts";
import { MAX_STEPS, nextClick } from "./jev.ts";
import { plan, replan, type Goal, type Page } from "./planner.ts";
import { killLive, need, startApp } from "./sandbox.ts";
import { verify } from "./verifier.ts";

const DOCS = "docs/docs";
const IMG = "docs/static/img";
let appUrl = ""; // the sandbox's preview link, set once per run
// out/<run>/<page>/<section>.gif, the record of every run. Only `npm run clean` empties it.
const RUN = `out/${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}`;
function log(line: string) {
  console.error(line);
  appendFileSync(`${RUN}/log.txt`, line + "\n");
}
// writeFile, creating the folders on the way.
async function put(path: string, data: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

type Browser = Awaited<ReturnType<typeof openBrowser>>;
type Run = Page & { browser: Browser; cursor: Uint8Array; goals?: Goal[] };

const steps: [string, (run: Run) => Promise<void>][] = [
  [
    "plan goals",
    async (run) => {
      run.goals = await plan(run);
      log(`  ${run.goals.length} worth recording`);
    },
  ],
  [
    "record",
    async (run) => {
      for (const g of run.goals!) await record(run, g);
    },
  ],
  [
    "verify",
    async (run) => {
      for (const g of run.goals!) await check(run, g);
    },
  ],
  [
    "retry failed",
    async (run) => {
      const failed = run.goals!.filter((g) => !g.verified);
      if (!failed.length) return;
      // one batched retry; loop it if a second pass ever pays off.
      await replan(run, run.goals!);
      for (const g of failed) {
        log(`  ${g.title}: ${g.instruction}`);
        await record(run, g);
        await check(run, g);
      }
    },
  ],
  [
    "write docs",
    async (run) => {
      const lines = run.text.split("\n");
      const rel = dirname(relative(DOCS, run.file));
      // Bottom-up so earlier line numbers stay valid after each insert.
      for (const g of run.goals!.filter((g) => g.verified).sort((a, b) => b.after_line - a.after_line)) {
        const embed = `![${g.title}](/img/${rel}/${key(run, g)})`;
        // A re-run overwrites the GIF in place; the embed only goes in once.
        await mkdir(dirname(`${IMG}/${rel}/${key(run, g)}`), { recursive: true });
        await copyFile(g.gif, `${IMG}/${rel}/${key(run, g)}`);
        if (lines.includes(embed)) continue;
        // The planner sometimes points mid-paragraph; walk down to the paragraph's last line so the GIF never splits a sentence.
        let at = g.after_line;
        while (lines[at - 1]?.trim() && lines[at]?.trim()) at++;
        lines.splice(at, 0, "", embed);
      }
      await writeFile(run.file, lines.join("\n"));
    },
  ],
  [
    "summary",
    async (run) => {
      const goals = run.goals!;
      for (const g of goals)
        log(`  ${g.verified ? "✓" : "✗"} ${g.title}${g.instruction ? " (retried)" : ""} → ${g.gif}`);
      log(`  ${goals.filter((g) => g.verified).length}/${goals.length} verified`);
    },
  ],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const key = (run: Run, g: Goal) => `${basename(run.file, ".md")}/${slug(g.title)}.gif`;
const out = (run: Run, g: Goal) => `${RUN}/${key(run, g)}`;

async function record(run: Run, g: Goal) {
  const b = run.browser;
  await b.navigate(appUrl);
  const frames: Frame[] = [];
  g.trace = [];
  let i = 0;
  for (; i < MAX_STEPS; i++) {
    const { ref, label } = await nextClick(g.instruction || g.goal, await b.tree(), g.trace);
    log(`  ${g.title}: ${label}`);
    if (ref === "done") break;
    g.trace.push(label);
    frames.push({ png: await b.screenshot(), at: await b.center(ref) });
    await b.click(ref);
    await b.page.waitForTimeout(400);
  }
  g.trace.push(i < MAX_STEPS ? "done" : "hit step cap");
  frames.push({ png: await b.screenshot() });
  g.gif = out(run, g);
  await put(g.gif, toGif(frames, run.cursor));
  await put(`${g.gif}.before.png`, frames[0]!.png);
  await put(`${g.gif}.png`, frames.at(-1)!.png);
}

async function check(run: Run, g: Goal) {
  // first and last frame, so "a row appears" is judged against where it started.
  const before = `${g.gif}.before.png`, after = `${g.gif}.png`;
  const { ok, reason } = await verify(g.goal, before, after);
  await rm(before);
  await rm(after);
  g.verified = ok;
  g.reason = reason;
  log(`  ${g.title}: ${ok ? "yes" : "no"} ${reason}`);
  // A failed attempt keeps its GIF under a .failed name; a retry writes a fresh one beside it.
  if (!ok) renameSync(g.gif, (g.gif = g.gif.replace(/\.gif$/, ".failed.gif")));
}

export async function pipeline(mode: "generate" | "update", files: string[]) {
  need("AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"); // before a sandbox or browser is billed
  await put(`${RUN}/log.txt`, "");
  log(`${mode}: ${files.length} page(s)`);
  for (const f of files) log(`  ${f}`);
  let browser: Browser | undefined;
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.once(sig, async () => {
      await Promise.allSettled([browser?.close(), killLive()]);
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  const app = await startApp();
  appUrl = app.url;
  log(`app on ${new URL(app.url).origin}`); // the full URL carries an access token
  try {
    for (const file of files) {
      log(`\n# ${file}`);
      // A fresh session per page keeps every session short: a page takes about a minute, and long-lived sessions have been seen to drop.
      const b = (browser = await openBrowser(app.headers));
      try {
        const cursor = await b.rasterize(CURSOR.svg, CURSOR.w, CURSOR.h);
        const run: Run = { file, text: await readFile(file, "utf8"), browser: b, cursor };
        for (const [name, step] of steps) {
          const t = Date.now();
          log(`→ ${name}`);
          await step(run);
          log(`  done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        }
      } finally {
        await b.close();
        browser = undefined;
      }
    }
  } finally {
    await app.kill();
  }
}
