/**
 * Publish captured runs as static assets.
 *
 * Demo mode has to work on a serverless host, where the API routes cannot hold
 * run state between requests and the Solari SDK will not load at all. Copying
 * the fixtures into public/ lets the client replay them with no server involved.
 *
 *   node scripts/build-demo-assets.mjs
 */
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "demo-fixtures";
const TARGET = join("public", "demo");

mkdirSync(TARGET, { recursive: true });

const hosts = readdirSync(SOURCE)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""));

const manifest = [];

for (const host of hosts) {
  const fixture = JSON.parse(readFileSync(join(SOURCE, `${host}.json`), "utf8"));

  let replayEvents = 0;
  try {
    const raw = readFileSync(join(SOURCE, `${host}.replay.ndjson.gz`));
    const text = gunzipSync(raw).toString("utf8");
    const events = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    writeFileSync(join(TARGET, `${host}.replay.json`), JSON.stringify(events));
    replayEvents = events.length;
  } catch {
    // A fixture without a recording simply has no replay button.
  }

  writeFileSync(
    join(TARGET, `${host}.json`),
    JSON.stringify({
      url: fixture.url,
      host: fixture.host,
      provider: fixture.provider,
      model: fixture.model,
      durationMs: fixture.durationMs,
      events: fixture.events,
      report: fixture.report,
      hasReplay: replayEvents > 0,
    }),
  );

  manifest.push({ host, events: fixture.events.length, replayEvents });
  console.log(
    `${host}: ${fixture.events.length} log events, ${replayEvents} replay events`,
  );
}

writeFileSync(join(TARGET, "index.json"), JSON.stringify(manifest, null, 2));
console.log(`\nwrote ${manifest.length} demo(s) to ${TARGET}`);
