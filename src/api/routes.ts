import { Router } from "express";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, count } from "drizzle-orm";
import { getWorkerStatus, getRunning, setRunning, setCycleId, incrementCycles, canRunCycle, startLoop, stopLoop, isLoopActive, getEvolutionMode, setEvolutionMode, type EvolutionMode } from "../worker/state.js";
import { getDeployStatus } from "../deploy/deployer.js";
import { getClient } from "../llm/openrouter.js";
import { runCycle, type UserIdea } from "../worker/cycle.js";
import { childLogger } from "../core/logger.js";
import { evaluateRoadmap, ROADMAP } from "../core/roadmap.js";
import { config } from "../core/config.js";
import { backupDb } from "../db/persist.js";

const log = childLogger("api");
export const apiRouter = Router();

apiRouter.get("/status", async (_req, res) => {
  const projects = await db.select().from(schema.projects).limit(1);
  const project = projects[0];
  const worker = getWorkerStatus();
  const deploy = getDeployStatus();
  const llmStats = getClient().stats;

  const todayCycles = await db
    .select({ count: count() })
    .from(schema.evolutionCycles)
    .where(sql`date(${schema.evolutionCycles.createdAt}) = date('now')`);

  res.json({
    project: project || null,
    worker,
    deploy,
    llm: llmStats,
    todayCycles: todayCycles[0]?.count || 0,
  });
});

apiRouter.get("/cycles", async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = parseInt(req.query.offset as string) || 0;
  const status = req.query.status as string;

  const cycles = status
    ? await db
        .select()
        .from(schema.evolutionCycles)
        .where(eq(schema.evolutionCycles.status, status))
        .orderBy(desc(schema.evolutionCycles.createdAt))
        .limit(limit)
        .offset(offset)
    : await db
        .select()
        .from(schema.evolutionCycles)
        .orderBy(desc(schema.evolutionCycles.createdAt))
        .limit(limit)
        .offset(offset);
  const total = await db.select({ count: count() }).from(schema.evolutionCycles);
  res.json({ cycles, total: total[0]?.count || 0 });
});

apiRouter.get("/cycles/:id", async (req, res) => {
  const cycle = await db
    .select()
    .from(schema.evolutionCycles)
    .where(eq(schema.evolutionCycles.id, req.params.id))
    .limit(1);

  if (!cycle.length) return res.status(404).json({ error: "Cycle not found" });

  const [observations, experiments, evaluations, commits, deployments] = await Promise.all([
    db.select().from(schema.observations).where(eq(schema.observations.cycleId, req.params.id)),
    db.select().from(schema.experiments).where(eq(schema.experiments.cycleId, req.params.id)),
    db.select().from(schema.evaluations).where(eq(schema.evaluations.cycleId, req.params.id)),
    db.select().from(schema.commits).where(eq(schema.commits.cycleId, req.params.id)),
    db.select().from(schema.deployments).where(eq(schema.deployments.cycleId, req.params.id)),
  ]);

  res.json({ ...cycle[0], observations, experiments, evaluations, commits, deployments });
});

apiRouter.get("/ideas", async (_req, res) => {
  const ideas = await db.select().from(schema.ideas).orderBy(desc(schema.ideas.priorityScore)).limit(50);
  res.json(ideas);
});

apiRouter.get("/memories", async (_req, res) => {
  const memories = await db.select().from(schema.memories).orderBy(desc(schema.memories.importance)).limit(50);
  res.json(memories);
});

apiRouter.get("/usage", async (_req, res) => {
  const usage = await db.select().from(schema.modelUsage).orderBy(desc(schema.modelUsage.createdAt)).limit(100);
  const totals = await db
    .select({
      totalRequests: count(),
      totalInputTokens: sql<number>`sum(${schema.modelUsage.inputTokens})`,
      totalOutputTokens: sql<number>`sum(${schema.modelUsage.outputTokens})`,
      totalCost: sql<number>`sum(${schema.modelUsage.estimatedCost})`,
    })
    .from(schema.modelUsage);
  res.json({ usage, totals: totals[0] });
});

apiRouter.get("/audit", async (_req, res) => {
  const logs = await db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.createdAt)).limit(100);
  res.json(logs);
});

apiRouter.get("/config", async (_req, res) => {
  const configs = await db.select().from(schema.systemConfig);
  res.json(configs);
});

apiRouter.post("/config", async (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: "key and value required" });
  await db
    .insert(schema.systemConfig)
    .values({ key, value: String(value), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: schema.systemConfig.key,
      set: { value: String(value), updatedAt: new Date().toISOString() },
    });
  res.json({ ok: true });
});

export async function ensureProjectAndRunCycle(userIdea?: UserIdea) {
  setRunning(true);
  try {
    let projects = await db.select().from(schema.projects).limit(1);
    if (!projects.length) {
      const { nanoid } = await import("nanoid");
      const id = nanoid();
      const now = new Date().toISOString();
      await db.insert(schema.projects).values({
        id,
        name: "Evolving App",
        description: "An application that improves itself autonomously",
        appDir: config.app.dir,
        identity: "A modern web application that continuously evolves",
        createdAt: now,
        updatedAt: now,
      });
      projects = await db.select().from(schema.projects).limit(1);
    }
    await runCycle(projects[0].id, userIdea);
    incrementCycles();
  } finally {
    setRunning(false);
    setCycleId(null);
    try { await backupDb(); } catch (e) { log.warn({ error: (e as Error).message }, "DB backup failed"); }
  }
}

apiRouter.post("/evolve", async (_req, res) => {
  if (getRunning()) {
    return res.status(409).json({ error: "A cycle is already running" });
  }
  if (!canRunCycle()) {
    return res.status(429).json({ error: "Daily cycle limit reached" });
  }

  res.json({ ok: true, message: "Evolution cycle triggered" });
  setImmediate(() => { ensureProjectAndRunCycle().catch((e) => log.error({ error: (e as Error).message }, "Manual cycle failed")); });
});

// Steered evolution: user provides a specific idea to build
apiRouter.post("/evolve/steer", async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  if (getRunning()) return res.status(409).json({ error: "A cycle is already running" });

  const idea: UserIdea = { title, description: description || title };
  res.json({ ok: true, message: `Steered evolution started: ${title}` });
  setImmediate(() => {
    ensureProjectAndRunCycle(idea).catch((e) => log.error({ error: (e as Error).message }, "Steered cycle failed"));
  });
});

// Idea planner: generate specific feature ideas
const FEATURE_IDEAS = [
  // ── Productivity tools ──
  { title: "Add drag-and-drop todo list", description: "Interactive todo list with add/delete/reorder/check-off, persisted in localStorage", category: "tool" },
  { title: "Add Pomodoro focus timer", description: "25/5/15 minute timer with start/pause/skip, lap counter, and toast notifications", category: "tool" },
  { title: "Add scientific calculator", description: "Full calculator with parentheses, history, and keyboard support", category: "tool" },
  { title: "Add markdown notepad with live preview", description: "Split-pane editor: write markdown on the left, see rendered HTML on the right, auto-saves to localStorage", category: "tool" },
  { title: "Add stopwatch with lap times", description: "Precision stopwatch with start/stop/lap/reset and lap time history", category: "tool" },
  { title: "Add weekly habit tracker", description: "Track daily habits on a 7-day grid with checkmarks, persisted in localStorage", category: "tool" },
  { title: "Add world clock with timezones", description: "Show current time in 6 major cities with live-updating seconds", category: "tool" },
  // ── Developer tools ──
  { title: "Add JSON formatter and validator", description: "Paste JSON, format/minify/validate with syntax highlighting and copy button", category: "devtool" },
  { title: "Add Base64 encoder/decoder", description: "Encode text to Base64 or decode Base64 back to text with one-click copy", category: "devtool" },
  { title: "Add regex tester with live matching", description: "Type a regex pattern and test string, see matches highlighted in real-time", category: "devtool" },
  { title: "Add CSS gradient generator", description: "Pick two colors and direction, see live preview, copy the CSS code", category: "devtool" },
  { title: "Add color picker and palette generator", description: "Pick a color, see HEX/RGB/HSL values, generate complement/analogous/shade palettes", category: "devtool" },
  { title: "Add lorem ipsum generator", description: "Generate 1-10 paragraphs of placeholder text with one-click copy", category: "devtool" },
  { title: "Add QR code generator", description: "Type any URL or text and see a QR code rendered on canvas", category: "devtool" },
  // ── Security & utility ──
  { title: "Add password generator", description: "Generate secure passwords with configurable length, uppercase, numbers, symbols, and strength meter", category: "tool" },
  { title: "Add unit converter", description: "Convert between length/weight/temperature/data units with instant results", category: "tool" },
  // ── More productivity ──
  { title: "Add expense tracker", description: "Log expenses with amount/category/date, see totals and a pie-chart breakdown, persisted in localStorage", category: "tool" },
  { title: "Add flashcard study system", description: "Create flashcard decks, flip to reveal answers, track correct/incorrect with spaced repetition", category: "tool" },
  { title: "Add kanban board", description: "Three-column (To Do / In Progress / Done) board with draggable cards and localStorage persistence", category: "tool" },
  { title: "Add bookmark manager", description: "Save and organize bookmarks with titles/URLs/tags, search and filter, export as JSON", category: "tool" },
  { title: "Add countdown to custom date", description: "Set any target date and see a live countdown in days/hours/minutes/seconds", category: "tool" },
  { title: "Add BMI calculator", description: "Enter height and weight, see BMI with color-coded category (underweight/normal/overweight/obese)", category: "tool" },
  { title: "Add tip calculator", description: "Enter bill amount and tip %, see tip, total, and per-person split for up to 10 people", category: "tool" },
  { title: "Add text diff checker", description: "Paste two texts side by side, see additions and deletions highlighted line by line", category: "devtool" },
  { title: "Add URL encoder/decoder", description: "Encode special characters for URLs or decode percent-encoded strings", category: "devtool" },
  { title: "Add hash generator (MD5/SHA)", description: "Generate MD5, SHA-1, SHA-256 hashes of any text input using Web Crypto API", category: "devtool" },
  { title: "Add typing speed test", description: "Timed typing test with random sentences, WPM calculation, accuracy percentage", category: "tool" },
  { title: "Add dice roller and coin flipper", description: "Roll any number of dice (d4-d100) or flip coins with animated results and history", category: "tool" },
  { title: "Add command palette (Ctrl+K)", description: "Spotlight-style command palette to quickly navigate, toggle theme, and run actions", category: "interactive" },
  { title: "Add interactive code playground", description: "Embedded HTML/CSS/JS editor with live preview in an iframe — build and test snippets", category: "devtool" },
];

let ideaPlannerTimer: ReturnType<typeof setInterval> | null = null;

apiRouter.get("/idea-bank", async (_req, res) => {
  const ideas = await db.select().from(schema.ideas)
    .orderBy(desc(schema.ideas.createdAt))
    .limit(50);
  res.json(ideas);
});

apiRouter.post("/idea-bank/generate", async (_req, res) => {
  try {
    const existingIdeas = await db.select({ title: schema.ideas.title }).from(schema.ideas);
    const existingTitles = new Set(existingIdeas.map(i => i.title));

    let fresh = FEATURE_IDEAS.filter(i => !existingTitles.has(i.title));
    if (!fresh.length) {
      // All ideas used — recycle with "v2/v3/..." suffix so they appear fresh
      const round = Math.floor(existingTitles.size / FEATURE_IDEAS.length) + 1;
      fresh = FEATURE_IDEAS.map(i => ({
        ...i,
        title: `${i.title} v${round}`,
        description: `${i.description} — enhanced version with improvements`,
      })).filter(i => !existingTitles.has(i.title));
      if (!fresh.length) return res.json({ ok: true, generated: 0, message: "All idea rounds generated" });
    }

    const batch = fresh.slice(0, 5);
    const { nanoid } = await import("nanoid");
    const now = new Date().toISOString();

    const projects = await db.select().from(schema.projects).limit(1);
    const projectId = projects[0]?.id || "default";

    for (const idea of batch) {
      await db.insert(schema.ideas).values({
        id: nanoid(),
        projectId,
        cycleId: "planner",
        title: idea.title,
        description: idea.description,
        category: idea.category,
        impact: Math.floor(Math.random() * 3) + 7,
        confidence: 9,
        effort: Math.floor(Math.random() * 3) + 2,
        strategicValue: Math.floor(Math.random() * 3) + 7,
        priorityScore: 50 + Math.floor(Math.random() * 50),
        status: "proposed",
        reason: "Generated by idea planner",
        createdAt: now,
      });
    }
    res.json({ ok: true, generated: batch.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

apiRouter.post("/loop/start", (_req, res) => {
  if (isLoopActive()) {
    return res.json({ ok: true, message: "Loop already running" });
  }
  startLoop(ensureProjectAndRunCycle);
  res.json({ ok: true, message: "Evolution loop started — cycles will run back-to-back" });
});

apiRouter.post("/loop/stop", (_req, res) => {
  stopLoop();
  res.json({ ok: true, message: "Evolution loop stopped" });
});

apiRouter.get("/loop/status", (_req, res) => {
  res.json({ active: isLoopActive(), ...getWorkerStatus() });
});

apiRouter.get("/evolution-mode", (_req, res) => {
  res.json({ mode: getEvolutionMode() });
});

apiRouter.post("/evolution-mode", (req, res) => {
  const { mode } = req.body;
  const valid: EvolutionMode[] = ["foundation", "features", "quality", "polish"];
  if (!valid.includes(mode)) {
    return res.status(400).json({ error: `Invalid mode. Valid: ${valid.join(", ")}` });
  }
  setEvolutionMode(mode);
  res.json({ ok: true, mode });
});

apiRouter.get("/commits", async (_req, res) => {
  const commits = await db.select().from(schema.commits).orderBy(desc(schema.commits.createdAt)).limit(50);
  res.json(commits);
});

apiRouter.get("/deployments", async (_req, res) => {
  const deployments = await db.select().from(schema.deployments).orderBy(desc(schema.deployments.createdAt)).limit(50);
  res.json(deployments);
});

apiRouter.get("/roadmap", (_req, res) => {
  try {
    const result = evaluateRoadmap(config.app.dir);
    res.json({
      currentStage: {
        id: result.currentStage.id,
        name: result.currentStage.name,
        description: result.currentStage.description,
        goals: result.currentStage.goals,
      },
      stages: result.stageStatuses.map((ss) => ({
        id: ss.stage.id,
        name: ss.stage.name,
        description: ss.stage.description,
        percentComplete: ss.percentComplete,
        isComplete: ss.isComplete,
        gates: ss.gateResults.map((g) => ({
          id: g.gate.id,
          description: g.gate.description,
          passed: g.passed,
        })),
      })),
      overallProgress: result.overallProgress,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

apiRouter.post("/snapshots/capture", async (_req, res) => {
  try {
    const projects = await db.select().from(schema.projects).limit(1);
    if (!projects.length) return res.status(404).json({ error: "No project" });
    const proj = projects[0];

    const { readdirSync, readFileSync, statSync } = await import("fs");
    const { resolve, relative } = await import("path");
    const { nanoid } = await import("nanoid");

    const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);
    const MAX_SIZE = 100_000;
    function collect(dir: string, base: string): { path: string; content: string }[] {
      const results: { path: string; content: string }[] = [];
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
          const full = resolve(dir, entry.name);
          if (entry.isDirectory()) results.push(...collect(full, base));
          else {
            try {
              if (statSync(full).size > MAX_SIZE) continue;
              results.push({ path: relative(base, full), content: readFileSync(full, "utf-8") });
            } catch {}
          }
        }
      } catch {}
      return results;
    }

    const files = collect(proj.appDir, proj.appDir);
    const now = new Date().toISOString();
    const version = proj.currentVersion || "0.0.0";

    for (const f of files) {
      await db.insert(schema.versionSnapshots).values({
        id: nanoid(),
        cycleId: "baseline-" + version,
        version,
        filePath: f.path,
        content: f.content,
        createdAt: now,
      });
    }
    res.json({ ok: true, files: files.length, version });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

apiRouter.get("/snapshots", async (_req, res) => {
  const versions = await db
    .selectDistinct({ version: schema.versionSnapshots.version, cycleId: schema.versionSnapshots.cycleId, createdAt: schema.versionSnapshots.createdAt })
    .from(schema.versionSnapshots)
    .orderBy(desc(schema.versionSnapshots.createdAt));
  res.json(versions);
});

apiRouter.get("/snapshots/:cycleId", async (req, res) => {
  const files = await db
    .select({ filePath: schema.versionSnapshots.filePath, content: schema.versionSnapshots.content })
    .from(schema.versionSnapshots)
    .where(eq(schema.versionSnapshots.cycleId, req.params.cycleId));
  if (!files.length) return res.status(404).json({ error: "No snapshot found" });
  res.json(files);
});

apiRouter.get("/snapshots/:cycleId/preview", async (req, res) => {
  const file = await db
    .select()
    .from(schema.versionSnapshots)
    .where(sql`${schema.versionSnapshots.cycleId} = ${req.params.cycleId} AND ${schema.versionSnapshots.filePath} = 'index.html'`)
    .limit(1);
  if (!file.length) return res.status(404).type("html").send("<html><body style='background:#0a0a0a;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui'><p>No preview available for this version.</p></body></html>");
  res.type("html").send(file[0].content);
});

apiRouter.get("/snapshots/:cycleId/:filePath", async (req, res) => {
  const filePath = req.params.filePath;
  const file = await db
    .select()
    .from(schema.versionSnapshots)
    .where(sql`${schema.versionSnapshots.cycleId} = ${req.params.cycleId} AND ${schema.versionSnapshots.filePath} = ${filePath}`)
    .limit(1);
  if (!file.length) return res.status(404).json({ error: "File not found in snapshot" });
  res.json(file[0]);
});
