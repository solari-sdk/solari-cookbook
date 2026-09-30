import { execSync } from "node:child_process";
import { pipeline } from "./index.ts";

const dir = process.argv[2] ?? "docs/docs/how-to";
// --relative: paths from this folder rather than the git root, so this works as a subfolder of a bigger repo.
const changed = execSync("git diff --name-only --relative HEAD; git ls-files --others --exclude-standard", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.startsWith(dir + "/") && f.endsWith(".md"))
  .sort();
if (!changed.length) {
  console.error(`nothing changed in ${dir} since the last commit`);
  process.exit(0);
}
await pipeline("update", changed);
