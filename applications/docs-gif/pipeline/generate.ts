import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "./index.ts";

const arg = process.argv[2] ?? "docs/docs/how-to";
const pages = arg.endsWith(".md")
  ? [arg]
  : (await readdir(arg)).filter((f) => f.endsWith(".md")).sort().map((f) => join(arg, f));
await pipeline("generate", pages);
