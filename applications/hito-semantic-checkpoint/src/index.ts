import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demo } from "./takeover.ts";
import { liveClient } from "./solari.ts";
import { receipt } from "./receipt.ts";
const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args[0] && !["same", "changed", "both"].includes(args[0]))
)
  throw Error("Use npm run demo -- same|changed|both");
const key = process.env.SOLARI_API_KEY;
if (!key) {
  console.error("SOLARI_API_KEY is required in the process environment.");
  process.exit(1);
}
const modes =
  args[0] === "both"
    ? (["same", "changed"] as const)
    : ([args[0] === "changed" ? "changed" : "same"] as const);
const output = join("runs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const clean = (value: string) => value.split(key).join("[REDACTED]");
try {
  const client = await liveClient(key, modes.length * 2);
  for (const mode of modes) {
    const result = await demo(
      client,
      mode,
      (message) => console.log(clean(message)),
      (e) =>
        writeFileSync(
          join(output, mode + ".json"),
          clean(JSON.stringify(e, null, 2)),
        ),
    );
    const text = clean(receipt(result));
    writeFileSync(join(output, mode + ".txt"), text);
    console.log(text);
    if (result.result !== "PASS") {
      process.exitCode = 1;
      break;
    }
  }
  console.log("Evidence saved under " + output);
} catch {
  console.error(
    "Demo incomplete. Preserve evidence; inspect sandbox cleanup before another run.",
  );
  process.exitCode = 1;
}
