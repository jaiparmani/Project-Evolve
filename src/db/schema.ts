import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  appDir: text("app_dir").notNull(),
  identity: text("identity"),
  principles: text("principles"),
  currentVersion: text("current_version").default("0.0.0"),
  qualityScore: real("quality_score").default(0),
  totalCycles: integer("total_cycles").default(0),
  successfulCycles: integer("successful_cycles").default(0),
  failedCycles: integer("failed_cycles").default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const evolutionCycles = sqliteTable("evolution_cycles", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  cycleNumber: integer("cycle_number").notNull(),
  status: text("status").notNull().default("pending"),
  phase: text("phase").default("pending"),

  observation: text("observation"),
  problemIdentified: text("problem_identified"),
  ideasConsidered: text("ideas_considered"),
  selectedImprovement: text("selected_improvement"),
  selectionReason: text("selection_reason"),
  implementationPlan: text("implementation_plan"),

  filesModified: text("files_modified"),
  commitSha: text("commit_sha"),
  pushStatus: text("push_status"),
  deployStatus: text("deploy_status"),

  testsExecuted: text("tests_executed"),
  testResults: text("test_results"),
  qualityBefore: real("quality_before"),
  qualityAfter: real("quality_after"),

  modelUsed: text("model_used"),
  tokensConsumed: integer("tokens_consumed").default(0),
  estimatedCost: real("estimated_cost").default(0),
  requestCount: integer("request_count").default(0),

  lessonsLearned: text("lessons_learned"),
  errorMessage: text("error_message"),

  previousVersion: text("previous_version"),
  newVersion: text("new_version"),

  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
});

export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull().references(() => evolutionCycles.id),
  category: text("category").notNull(),
  description: text("description").notNull(),
  severity: text("severity").default("medium"),
  details: text("details"),
  createdAt: text("created_at").notNull(),
});

export const ideas = sqliteTable("ideas", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  cycleId: text("cycle_id").references(() => evolutionCycles.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  impact: real("impact").default(5),
  confidence: real("confidence").default(5),
  effort: real("effort").default(5),
  strategicValue: real("strategic_value").default(5),
  priorityScore: real("priority_score").default(0),
  status: text("status").default("proposed"),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
});

export const experiments = sqliteTable("experiments", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull().references(() => evolutionCycles.id),
  ideaId: text("idea_id").references(() => ideas.id),
  worktreePath: text("worktree_path"),
  branchName: text("branch_name"),
  status: text("status").default("pending"),
  implementationLog: text("implementation_log"),
  filesChanged: text("files_changed"),
  linesAdded: integer("lines_added").default(0),
  linesRemoved: integer("lines_removed").default(0),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const evaluations = sqliteTable("evaluations", {
  id: text("id").primaryKey(),
  experimentId: text("experiment_id").notNull().references(() => experiments.id),
  cycleId: text("cycle_id").notNull().references(() => evolutionCycles.id),
  typescriptCheck: text("typescript_check"),
  lintCheck: text("lint_check"),
  unitTests: text("unit_tests"),
  buildCheck: text("build_check"),
  overallResult: text("overall_result").default("pending"),
  qualityScore: real("quality_score"),
  criticFeedback: text("critic_feedback"),
  rejected: integer("rejected", { mode: "boolean" }).default(false),
  rejectionReason: text("rejection_reason"),
  createdAt: text("created_at").notNull(),
});

export const deployments = sqliteTable("deployments", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull().references(() => evolutionCycles.id),
  strategy: text("strategy").notNull(),
  status: text("status").default("pending"),
  version: text("version"),
  healthCheckResult: text("health_check_result"),
  rollbackPerformed: integer("rollback_performed", { mode: "boolean" }).default(false),
  deployLog: text("deploy_log"),
  url: text("url"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const commits = sqliteTable("commits", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull().references(() => evolutionCycles.id),
  sha: text("sha").notNull(),
  message: text("message").notNull(),
  branch: text("branch").notNull(),
  filesChanged: integer("files_changed").default(0),
  insertions: integer("insertions").default(0),
  deletions: integer("deletions").default(0),
  pushed: integer("pushed", { mode: "boolean" }).default(false),
  pushError: text("push_error"),
  createdAt: text("created_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  category: text("category").notNull(),
  content: text("content").notNull(),
  importance: real("importance").default(5),
  accessCount: integer("access_count").default(0),
  lastAccessed: text("last_accessed"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const modelUsage = sqliteTable("model_usage", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").references(() => evolutionCycles.id),
  agent: text("agent").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  estimatedCost: real("estimated_cost").default(0),
  cached: integer("cached", { mode: "boolean" }).default(false),
  durationMs: integer("duration_ms"),
  createdAt: text("created_at").notNull(),
});

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id").notNull().references(() => evolutionCycles.id),
  agent: text("agent").notNull(),
  status: text("status").default("running"),
  input: text("input"),
  output: text("output"),
  tokensUsed: integer("tokens_used").default(0),
  durationMs: integer("duration_ms"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const systemConfig = sqliteTable("system_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  details: text("details"),
  cycleId: text("cycle_id"),
  createdAt: text("created_at").notNull(),
});

export const versionSnapshots = sqliteTable("version_snapshots", {
  id: text("id").primaryKey(),
  cycleId: text("cycle_id"),
  version: text("version").notNull(),
  filePath: text("file_path").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});
