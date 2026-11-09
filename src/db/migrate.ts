import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const dbPath = resolve(process.cwd(), "data", "evolve.db");
if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const tables = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  app_dir TEXT NOT NULL,
  identity TEXT,
  principles TEXT,
  current_version TEXT DEFAULT '0.0.0',
  quality_score REAL DEFAULT 0,
  total_cycles INTEGER DEFAULT 0,
  successful_cycles INTEGER DEFAULT 0,
  failed_cycles INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_cycles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cycle_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  phase TEXT DEFAULT 'pending',
  observation TEXT,
  problem_identified TEXT,
  ideas_considered TEXT,
  selected_improvement TEXT,
  selection_reason TEXT,
  implementation_plan TEXT,
  files_modified TEXT,
  commit_sha TEXT,
  push_status TEXT,
  deploy_status TEXT,
  tests_executed TEXT,
  test_results TEXT,
  quality_before REAL,
  quality_after REAL,
  model_used TEXT,
  tokens_consumed INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  lessons_learned TEXT,
  error_message TEXT,
  previous_version TEXT,
  new_version TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES evolution_cycles(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cycle_id TEXT REFERENCES evolution_cycles(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  impact REAL DEFAULT 5,
  confidence REAL DEFAULT 5,
  effort REAL DEFAULT 5,
  strategic_value REAL DEFAULT 5,
  priority_score REAL DEFAULT 0,
  status TEXT DEFAULT 'proposed',
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES evolution_cycles(id),
  idea_id TEXT REFERENCES ideas(id),
  worktree_path TEXT,
  branch_name TEXT,
  status TEXT DEFAULT 'pending',
  implementation_log TEXT,
  files_changed TEXT,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  cycle_id TEXT NOT NULL REFERENCES evolution_cycles(id),
  typescript_check TEXT,
  lint_check TEXT,
  unit_tests TEXT,
  build_check TEXT,
  overall_result TEXT DEFAULT 'pending',
  quality_score REAL,
  critic_feedback TEXT,
  rejected INTEGER DEFAULT 0,
  rejection_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES evolution_cycles(id),
  strategy TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  version TEXT,
  health_check_result TEXT,
  rollback_performed INTEGER DEFAULT 0,
  deploy_log TEXT,
  url TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES evolution_cycles(id),
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  branch TEXT NOT NULL,
  files_changed INTEGER DEFAULT 0,
  insertions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  pushed INTEGER DEFAULT 0,
  push_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL DEFAULT 5,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage (
  id TEXT PRIMARY KEY,
  cycle_id TEXT REFERENCES evolution_cycles(id),
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  cached INTEGER DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES evolution_cycles(id),
  agent TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  input TEXT,
  output TEXT,
  tokens_used INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  details TEXT,
  cycle_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cycles_project ON evolution_cycles(project_id);
CREATE INDEX IF NOT EXISTS idx_cycles_status ON evolution_cycles(status);
CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_cycle ON model_usage(cycle_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_cycle ON agent_runs(cycle_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

CREATE TABLE IF NOT EXISTS version_snapshots (
  id TEXT PRIMARY KEY,
  cycle_id TEXT,
  version TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_cycle ON version_snapshots(cycle_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_version ON version_snapshots(version);
`;

for (const stmt of tables.split(";").filter((s) => s.trim())) {
  sqlite.exec(stmt + ";");
}

console.log("Database migrated successfully at", dbPath);
sqlite.close();
