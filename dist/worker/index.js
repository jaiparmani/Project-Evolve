import { CronJob } from "cron";
import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { db, schema } from "../db/index.js";
import { runCycle } from "./cycle.js";
import { getRunning, setRunning, setCycleId, incrementCycles, canRunCycle } from "./state.js";
import { nanoid } from "nanoid";
const log = childLogger("worker");
async function ensureProject() {
    const existing = await db.select().from(schema.projects).limit(1);
    if (existing.length)
        return existing[0].id;
    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
        id,
        name: "Evolving App",
        description: "An application that improves itself autonomously",
        appDir: config.app.dir,
        identity: "A modern web application that continuously evolves",
        principles: JSON.stringify([
            "User experience first",
            "Performance matters",
            "Clean, maintainable code",
            "Accessibility by default",
            "Security is non-negotiable",
        ]),
        createdAt: now,
        updatedAt: now,
    });
    log.info({ id }, "Created default project");
    return id;
}
async function tick() {
    if (getRunning()) {
        log.warn("Previous cycle still running, skipping");
        return;
    }
    if (!canRunCycle()) {
        log.info("Daily cycle limit reached, waiting for tomorrow");
        return;
    }
    setRunning(true);
    try {
        const projectId = await ensureProject();
        log.info("Starting evolution cycle");
        const result = await runCycle(projectId);
        incrementCycles();
        log.info({ status: result.status, improvement: result.improvement, sha: result.commitSha }, "Cycle completed");
    }
    catch (error) {
        log.error({ error: error.message }, "Cycle failed unexpectedly");
    }
    finally {
        setRunning(false);
        setCycleId(null);
    }
}
const cronExpression = `*/${config.evolution.intervalMinutes} * * * *`;
log.info("Worker starting with interval: every %d minutes", config.evolution.intervalMinutes);
const job = new CronJob(cronExpression, tick, null, false, "UTC");
process.on("SIGTERM", () => { log.info("Worker shutting down"); job.stop(); process.exit(0); });
process.on("SIGINT", () => { log.info("Worker interrupted"); job.stop(); process.exit(0); });
job.start();
log.info("Evolution worker started. First cycle runs in 5s.");
setTimeout(() => {
    log.info("Running initial cycle...");
    tick().catch((e) => log.error({ error: e.message }, "Initial cycle failed"));
}, 5000);
//# sourceMappingURL=index.js.map