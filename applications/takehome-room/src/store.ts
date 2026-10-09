// Interviews are JSON files in a data folder. One process owns the folder, so
// plain files with atomic renames are enough. Artifacts sit next to the records.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Interview } from "./interview.ts"

export interface Store {
  save(iv: Interview): void
  load(id: string): Interview | undefined
  all(): Interview[]
  byCandidateToken(token: string): Interview | undefined
  byReviewerToken(token: string): Interview | undefined
  /** Where an Interview's Final state, Recording and test output are kept. Created on first use. */
  artifactDir(id: string): string
}

export function createStore(dir: string): Store {
  const records = join(dir, "interviews")
  const recordPath = (id: string) => join(records, `${id}.json`)

  const all = (): Interview[] =>
    existsSync(records)
      ? readdirSync(records)
          .filter((f) => f.endsWith(".json"))
          .map((f) => JSON.parse(readFileSync(join(records, f), "utf8")) as Interview)
      : []

  return {
    save(iv) {
      mkdirSync(records, { recursive: true })
      const path = recordPath(iv.id)
      writeFileSync(path + ".tmp", JSON.stringify(iv, null, 2))
      renameSync(path + ".tmp", path)
    },
    load(id) {
      const path = recordPath(id)
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined
    },
    all,
    byCandidateToken: (token) => all().find((iv) => iv.candidateToken === token),
    byReviewerToken: (token) => all().find((iv) => iv.reviewerToken === token),
    artifactDir(id) {
      const path = join(dir, "artifacts", id)
      mkdirSync(path, { recursive: true })
      return path
    },
  }
}
