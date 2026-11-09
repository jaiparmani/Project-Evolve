import { config } from "../core/config.js";

let isRunning = false;
let currentCycleId: string | null = null;
let cyclesRanToday = 0;
let lastDayReset = new Date().toDateString();

export function getWorkerStatus() {
  return {
    isRunning,
    currentCycleId,
    cyclesRanToday,
    maxCyclesPerDay: config.evolution.maxCyclesPerDay,
    intervalMinutes: config.evolution.intervalMinutes,
  };
}

export function setRunning(val: boolean) { isRunning = val; }
export function getRunning() { return isRunning; }
export function setCycleId(id: string | null) { currentCycleId = id; }
export function incrementCycles() {
  const today = new Date().toDateString();
  if (today !== lastDayReset) { cyclesRanToday = 0; lastDayReset = today; }
  cyclesRanToday++;
}
export function canRunCycle(): boolean {
  const today = new Date().toDateString();
  if (today !== lastDayReset) { cyclesRanToday = 0; lastDayReset = today; }
  return cyclesRanToday < config.evolution.maxCyclesPerDay;
}
