import { Router } from "express";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, count } from "drizzle-orm";
import { getWorkerStatus, getRunning, setRunning, setCycleId, incrementCycles, canRunCycle, startLoop, stopLoop, isLoopActive } from "../worker/state.js";
import { getDeployStatus } from "../deploy/deployer.js";
import { getClient } from "../llm/openrouter.js";
import { runCycle } from "../worker/cycle.js";
import { childLogger } from "../core/logger.js";
import { evaluateRoadmap } from "../core/roadmap.js";
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
        .where(sql `date(${schema.evolutionCycles.createdAt}) = date('now')`);
    res.json({
        project: project || null,
        worker,
        deploy,
        llm: llmStats,
        todayCycles: todayCycles[0]?.count || 0,
    });
});
apiRouter.get("/cycles", async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;
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
    if (!cycle.length)
        return res.status(404).json({ error: "Cycle not found" });
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
        totalInputTokens: sql `sum(${schema.modelUsage.inputTokens})`,
        totalOutputTokens: sql `sum(${schema.modelUsage.outputTokens})`,
        totalCost: sql `sum(${schema.modelUsage.estimatedCost})`,
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
    if (!key || value === undefined)
        return res.status(400).json({ error: "key and value required" });
    await db
        .insert(schema.systemConfig)
        .values({ key, value: String(value), updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
        target: schema.systemConfig.key,
        set: { value: String(value), updatedAt: new Date().toISOString() },
    });
    res.json({ ok: true });
});
export async function ensureProjectAndRunCycle() {
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
        await runCycle(projects[0].id);
        incrementCycles();
    }
    finally {
        setRunning(false);
        setCycleId(null);
        try {
            await backupDb();
        }
        catch (e) {
            log.warn({ error: e.message }, "DB backup failed");
        }
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
    setImmediate(() => { ensureProjectAndRunCycle().catch((e) => log.error({ error: e.message }, "Manual cycle failed")); });
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
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
apiRouter.post("/snapshots/capture", async (_req, res) => {
    try {
        const projects = await db.select().from(schema.projects).limit(1);
        if (!projects.length)
            return res.status(404).json({ error: "No project" });
        const proj = projects[0];
        const { readdirSync, readFileSync, statSync } = await import("fs");
        const { resolve, relative } = await import("path");
        const { nanoid } = await import("nanoid");
        const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);
        const MAX_SIZE = 100_000;
        function collect(dir, base) {
            const results = [];
            try {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    if (SKIP.has(entry.name) || entry.name.startsWith("."))
                        continue;
                    const full = resolve(dir, entry.name);
                    if (entry.isDirectory())
                        results.push(...collect(full, base));
                    else {
                        try {
                            if (statSync(full).size > MAX_SIZE)
                                continue;
                            results.push({ path: relative(base, full), content: readFileSync(full, "utf-8") });
                        }
                        catch { }
                    }
                }
            }
            catch { }
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
    }
    catch (e) {
        res.status(500).json({ error: e.message });
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
    if (!files.length)
        return res.status(404).json({ error: "No snapshot found" });
    res.json(files);
});
apiRouter.get("/snapshots/:cycleId/preview", async (req, res) => {
    const file = await db
        .select()
        .from(schema.versionSnapshots)
        .where(sql `${schema.versionSnapshots.cycleId} = ${req.params.cycleId} AND ${schema.versionSnapshots.filePath} = 'index.html'`)
        .limit(1);
    if (!file.length)
        return res.status(404).type("html").send("<html><body style='background:#0a0a0a;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui'><p>No preview available for this version.</p></body></html>");
    res.type("html").send(file[0].content);
});
apiRouter.get("/snapshots/:cycleId/:filePath", async (req, res) => {
    const filePath = req.params.filePath;
    const file = await db
        .select()
        .from(schema.versionSnapshots)
        .where(sql `${schema.versionSnapshots.cycleId} = ${req.params.cycleId} AND ${schema.versionSnapshots.filePath} = ${filePath}`)
        .limit(1);
    if (!file.length)
        return res.status(404).json({ error: "File not found in snapshot" });
    res.json(file[0]);
});
//# sourceMappingURL=routes.js.map