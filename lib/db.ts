import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Opens (and if needed creates) the SQLite file that holds rate-limit hits and stored reports. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS hits (bucket TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS hits_bucket_ts ON hits (bucket, ts);
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_domain_created ON reports (domain, created_at);
  `);
  return db;
}

let shared: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  shared ??= openDb(process.env.SITERECON_DB ?? "./data/siterecon.db");
  return shared;
}
