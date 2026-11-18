import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import * as schema from "./schema.js";
import { restoreDb } from "./persist.js";

const dbPath = resolve(process.cwd(), "data", "evolve.db");

if (!existsSync(dirname(dbPath))) {
  mkdirSync(dirname(dbPath), { recursive: true });
}

restoreDb();

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Lightweight runtime migration: the DB file is restored from git at boot,
// so columns added after it was created have to be added here.
const IDEA_COLUMNS: Record<string, string> = {
  source: "TEXT DEFAULT 'system'",
  analysis: "TEXT",
  queue_rank: "REAL",
  picked_cycle_id: "TEXT",
  updated_at: "TEXT",
  attempts: "INTEGER DEFAULT 0",
};
try {
  const cols = new Set((sqlite.prepare("PRAGMA table_info(ideas)").all() as Array<{ name: string }>).map((c) => c.name));
  if (cols.size) {
    for (const [name, type] of Object.entries(IDEA_COLUMNS)) {
      if (!cols.has(name)) sqlite.exec(`ALTER TABLE ideas ADD COLUMN ${name} ${type}`);
    }
  }
} catch (e) {
  console.warn("ideas column migration failed:", (e as Error).message);
}

export const db = drizzle(sqlite, { schema });
export { schema };
export type DB = typeof db;
