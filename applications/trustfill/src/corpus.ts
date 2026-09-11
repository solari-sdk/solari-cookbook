import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The whole corpus goes into context. M0 measured it at ~6.2k tokens, so a
 * vector store here would be architecture for its own sake — see scope §5.
 */
export async function loadCorpus(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort()
  const docs = await Promise.all(
    files.map(async (f) => `<document name="${f}">\n${await readFile(join(dir, f), "utf8")}\n</document>`),
  )
  return docs.join("\n\n")
}
