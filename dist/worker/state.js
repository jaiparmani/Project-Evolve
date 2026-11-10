import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
const log = childLogger("worker");
let isRunning = false;
let currentCycleId = null;
let cyclesRanToday = 0;
let lastDayReset = new Date().toDateString();
let loopActive = false;
let loopTimer = null;
const VALID_MODES = ["foundation", "features", "quality", "polish"];
let evolutionMode = "foundation";
export function getEvolutionMode() { return evolutionMode; }
export function setEvolutionMode(mode) {
    evolutionMode = mode;
    log.info({ mode }, "Evolution mode changed");
    persistMode(mode);
}
async function persistMode(mode) {
    try {
        const { db, schema } = await import("../db/index.js");
        await db.insert(schema.systemConfig)
            .values({ key: "evolution_mode", value: mode, updatedAt: new Date().toISOString() })
            .onConflictDoUpdate({ target: schema.systemConfig.key, set: { value: mode, updatedAt: new Date().toISOString() } });
    }
    catch (e) {
        log.warn({ error: e.message }, "Failed to persist evolution mode");
    }
}
export async function loadEvolutionModeFromDb() {
    try {
        const { db, schema } = await import("../db/index.js");
        const { eq } = await import("drizzle-orm");
        const rows = await db.select().from(schema.systemConfig).where(eq(schema.systemConfig.key, "evolution_mode")).limit(1);
        if (rows.length && VALID_MODES.includes(rows[0].value)) {
            evolutionMode = rows[0].value;
            log.info({ mode: evolutionMode }, "Loaded evolution mode from DB");
        }
    }
    catch (e) {
        log.warn({ error: e.message }, "Failed to load evolution mode from DB");
    }
}
export function getWorkerStatus() {
    return {
        isRunning,
        currentCycleId,
        cyclesRanToday,
        maxCyclesPerDay: config.evolution.maxCyclesPerDay,
        intervalMinutes: config.evolution.intervalMinutes,
        loopActive,
    };
}
export function setRunning(val) { isRunning = val; }
export function getRunning() { return isRunning; }
export function setCycleId(id) { currentCycleId = id; }
export function incrementCycles() {
    const today = new Date().toDateString();
    if (today !== lastDayReset) {
        cyclesRanToday = 0;
        lastDayReset = today;
    }
    cyclesRanToday++;
}
export function canRunCycle() {
    const today = new Date().toDateString();
    if (today !== lastDayReset) {
        cyclesRanToday = 0;
        lastDayReset = today;
    }
    return cyclesRanToday < config.evolution.maxCyclesPerDay;
}
export function isLoopActive() { return loopActive; }
const DELAY_BETWEEN_CYCLES_MS = 90_000;
export function startLoop(runOneCycle) {
    if (loopActive)
        return;
    loopActive = true;
    log.info("Evolution loop STARTED — cycles will run back-to-back");
    async function tick() {
        if (!loopActive)
            return;
        if (!canRunCycle()) {
            log.info("Daily cycle limit reached — loop pausing until tomorrow");
            loopTimer = setTimeout(tick, 60 * 60 * 1000);
            return;
        }
        if (isRunning) {
            loopTimer = setTimeout(tick, 10_000);
            return;
        }
        try {
            await runOneCycle();
        }
        catch (e) {
            log.error({ error: e.message }, "Loop cycle failed");
        }
        if (loopActive) {
            log.info({ delayMs: DELAY_BETWEEN_CYCLES_MS }, "Next cycle in %d seconds", DELAY_BETWEEN_CYCLES_MS / 1000);
            loopTimer = setTimeout(tick, DELAY_BETWEEN_CYCLES_MS);
        }
    }
    tick();
}
export function stopLoop() {
    loopActive = false;
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
    log.info("Evolution loop STOPPED");
}
//# sourceMappingURL=state.js.map