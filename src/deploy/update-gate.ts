/**
 * Deploy gate and keep-alive for Render.
 *
 * Problem: every push redeploys the service, and the restart kills whatever
 * cycle is running ("Orphaned by redeploy"). The free plan also sleeps after
 * 15 minutes without inbound traffic, which kills cycles the same way.
 *
 * Gate: with Auto-Deploy turned off in Render and a Deploy Hook URL in
 * RENDER_DEPLOY_HOOK_URL, the app watches GitHub for new code commits and
 * triggers the deploy itself, only between cycles. Without a hook it just
 * reports pending updates and Render keeps deploying on push as before.
 *
 * Keep-alive: pings its own public URL so the free instance never idles out
 * while the evolution loop is on.
 */
import { childLogger } from "../core/logger.js";

const log = childLogger("update-gate");

const RUNNING_COMMIT = process.env.RENDER_GIT_COMMIT || "";
const HOOK_URL = process.env.RENDER_DEPLOY_HOOK_URL || "";
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || "";
const REPO = process.env.EVOLVE_GITHUB_REPO || "jaiparmani/Project-Evolve";

export interface PendingCommit { sha: string; message: string; date: string }

const state = {
  pending: [] as PendingCommit[],
  lastCheck: null as string | null,
  lastError: null as string | null,
  deploying: false,
  deployRequestedAt: null as string | null,
};

export function deployGateStatus() {
  return {
    runningCommit: RUNNING_COMMIT ? RUNNING_COMMIT.slice(0, 7) : null,
    hookConfigured: !!HOOK_URL,
    keepAlive: !!EXTERNAL_URL,
    pending: state.pending,
    lastCheck: state.lastCheck,
    lastError: state.lastError,
    deploying: state.deploying,
    deployRequestedAt: state.deployRequestedAt,
  };
}

/** True when the loop should not start another cycle because a deploy is about to restart us. */
export function holdForDeploy(): boolean {
  return state.deploying;
}

export async function checkForUpdates(): Promise<void> {
  if (!RUNNING_COMMIT) return; // not on Render, nothing to compare against
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/compare/${RUNNING_COMMIT}...main`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GitHub compare ${res.status}`);
    const data = (await res.json()) as { commits?: Array<{ sha: string; commit: { message: string; committer?: { date?: string } } }> };
    state.pending = (data.commits || [])
      .filter((c) => !/\[skip render\]|\[render skip\]|\[skip ci\]/i.test(c.commit.message))
      .map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0].slice(0, 140), date: c.commit.committer?.date || "" }));
    state.lastError = null;
  } catch (e) {
    state.lastError = (e as Error).message;
  } finally {
    state.lastCheck = new Date().toISOString();
  }
}

/** Trigger the Render deploy hook after saving the DB. Returns false when no hook is configured. */
export async function triggerDeploy(reason: string): Promise<boolean> {
  if (!HOOK_URL || state.deploying) return false;
  state.deploying = true;
  state.deployRequestedAt = new Date().toISOString();
  log.info({ reason, pending: state.pending.map((p) => p.sha) }, "Triggering deploy between cycles");
  try {
    const { backupDb } = await import("../db/persist.js");
    await backupDb("before deploy");
    const res = await fetch(HOOK_URL, { method: "POST", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Deploy hook returned ${res.status}`);
    // Render now builds and will SIGTERM us when the new instance is live.
    // If nothing happens within 20 minutes, resume cycles.
    setTimeout(() => { if (state.deploying) { state.deploying = false; log.warn("Deploy did not restart the service — resuming cycles"); } }, 20 * 60_000);
    return true;
  } catch (e) {
    state.deploying = false;
    state.lastError = (e as Error).message;
    log.error({ error: state.lastError }, "Deploy hook failed");
    return false;
  }
}

/**
 * Called by the loop right before it would start a cycle. If code is waiting
 * and a hook is configured, deploy now (we're between cycles) and hold.
 */
export async function maybeDeployBetweenCycles(): Promise<boolean> {
  if (!HOOK_URL) return false;
  if (state.deploying) return true;
  if (!state.pending.length) return false;
  return triggerDeploy("new code waiting");
}

let started = false;
export function startUpdateGate() {
  if (started) return;
  started = true;
  if (RUNNING_COMMIT) {
    void checkForUpdates();
    setInterval(() => { void checkForUpdates(); }, 2 * 60_000);
    log.info({ commit: RUNNING_COMMIT.slice(0, 7), hook: !!HOOK_URL }, "Update gate active");
  }
  if (EXTERNAL_URL) {
    // Render's free plan sleeps after 15 idle minutes, which kills a running cycle.
    setInterval(async () => {
      try {
        const { isLoopActive, getRunning } = await import("../worker/state.js");
        if (!isLoopActive() && !getRunning()) return;
        await fetch(`${EXTERNAL_URL}/health`, { signal: AbortSignal.timeout(20_000) });
      } catch { /* best effort */ }
    }, 10 * 60_000);
    log.info({ url: EXTERNAL_URL }, "Keep-alive enabled");
  }
}
