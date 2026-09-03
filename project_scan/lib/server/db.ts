import postgres from "postgres";
import type { StoredScan } from "@/lib/types";
import { env } from "./env";

let sql: ReturnType<typeof postgres> | null = null;

function getSql() {
  if (!sql) {
    const url = env("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL is not set");
    sql = postgres(url, { max: 10 });
  }
  return sql;
}

export async function migrate(): Promise<void> {
  const db = getSql();
  await db`
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      hostname TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence INT NOT NULL,
      summary TEXT NOT NULL,
      priority_fixes JSONB NOT NULL DEFAULT '[]',
      findings JSONB NOT NULL DEFAULT '[]',
      replay_url TEXT,
      duration_ms INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await db`
    CREATE INDEX IF NOT EXISTS scans_hostname_created_idx ON scans (hostname, created_at DESC)
  `;
}

export async function saveScan(scan: StoredScan): Promise<void> {
  const db = getSql();
  await db`
    INSERT INTO scans (
      id, url, hostname, verdict, confidence, summary,
      priority_fixes, findings, replay_url, duration_ms, created_at
    ) VALUES (
      ${scan.id}, ${scan.url}, ${scan.hostname}, ${scan.verdict}, ${scan.confidence},
      ${scan.summary}, ${JSON.stringify(scan.priorityFixes)}, ${JSON.stringify(scan.findings)},
      ${scan.replayUrl ?? null}, ${scan.durationMs}, ${scan.createdAt}
    )
  `;
}

export async function getScan(id: string): Promise<StoredScan | null> {
  const db = getSql();
  const rows = await db`
    SELECT id, url, hostname, verdict, confidence, summary,
           priority_fixes, findings, replay_url, duration_ms, created_at
    FROM scans WHERE id = ${id} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    url: row.url as string,
    hostname: row.hostname as string,
    verdict: row.verdict as StoredScan["verdict"],
    confidence: row.confidence as number,
    summary: row.summary as string,
    priorityFixes: row.priority_fixes as string[],
    findings: row.findings as StoredScan["findings"],
    replayUrl: (row.replay_url as string | null) ?? null,
    durationMs: row.duration_ms as number,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export async function countScansToday(hostname: string): Promise<number> {
  const db = getSql();
  const rows = await db`
    SELECT COUNT(*)::int AS n FROM scans
    WHERE hostname = ${hostname}
      AND created_at >= date_trunc('day', NOW())
  `;
  return (rows[0]?.n as number) ?? 0;
}

export async function pingDb(): Promise<boolean> {
  try {
    const db = getSql();
    await db`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
