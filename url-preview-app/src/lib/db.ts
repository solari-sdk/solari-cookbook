import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import * as schema from "./schema"
import * as fs from "fs"
import * as path from "path"

const dbPath = path.resolve(process.cwd(), "data/app.db")
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath)
sqlite.pragma("journal_mode = WAL")

export const db = drizzle(sqlite, { schema })
