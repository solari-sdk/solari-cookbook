import { readFile } from "node:fs/promises"
const html = await readFile(new URL("./index.html", import.meta.url), "utf8")
if (!html.includes("AI repaired this UI in Solari")) {
  throw new Error("AI repair text is missing")
}
console.log("AI mutation fixture test passed")
