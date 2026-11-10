import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
const log = childLogger("worker");
let isRunning = false;
let currentCycleId = null;
let cyclesRanToday = 0;
let lastDayReset = new Date().toDateString();
let loopActive = false;
let loopTimer = null;
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