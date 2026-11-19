/**
 * When the LLM gateway reports that every key's quota is used up, there is no
 * point running cycles: each step would fail, retry, and fall back to filler
 * changes, while burning calls that other apps sharing the gateway need too.
 * This holds the engine until the reset time the gateway reports.
 */
export class QuotaExhaustedError extends Error {
  constructor(message: string, public resetAt: string | null) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

let pausedUntil: number | null = null;
let pauseReason = "";

/** Default wait when the gateway doesn't say when the quota resets. */
const FALLBACK_PAUSE_MS = 30 * 60_000;

export function pauseForQuota(err: QuotaExhaustedError) {
  const t = err.resetAt ? Date.parse(err.resetAt) : NaN;
  const until = Number.isFinite(t) && t > Date.now() ? t : Date.now() + FALLBACK_PAUSE_MS;
  const changed = !pausedUntil || until > pausedUntil;
  if (changed) pausedUntil = until;
  pauseReason = err.message.slice(0, 300);
  if (changed) void persistPause();
}

// The pause is saved in the DB so it survives restarts: Render's free plan
// restarts the process on its own, and each fresh process used to run one
// cycle straight into the spent quota before rediscovering it.
async function persistPause() {
  try {
    const { db, schema } = await import("../db/index.js");
    const value = JSON.stringify({ until: pausedUntil ? new Date(pausedUntil).toISOString() : null, reason: pauseReason });
    const now = new Date().toISOString();
    await db.insert(schema.systemConfig).values({ key: "llm_quota_pause", value, updatedAt: now })
      .onConflictDoUpdate({ target: schema.systemConfig.key, set: { value, updatedAt: now } });
    const { scheduleBackup } = await import("../db/persist.js");
    scheduleBackup(5_000, "after quota pause");
  } catch { /* best effort */ }
}

/** Restore a saved pause on boot (ignored once its reset time has passed). */
export async function loadQuotaPause() {
  try {
    const { db, schema } = await import("../db/index.js");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(schema.systemConfig).where(eq(schema.systemConfig.key, "llm_quota_pause"));
    if (!row) return;
    const saved = JSON.parse(row.value) as { until: string | null; reason?: string };
    const t = saved.until ? Date.parse(saved.until) : NaN;
    if (Number.isFinite(t) && t > Date.now()) { pausedUntil = t; pauseReason = saved.reason || "LLM quota used up"; }
  } catch { /* best effort */ }
}

/** The active pause, or null. Clears itself once the reset time passes. */
export function quotaPause(): { until: string; reason: string } | null {
  if (pausedUntil && Date.now() >= pausedUntil) pausedUntil = null;
  return pausedUntil ? { until: new Date(pausedUntil).toISOString(), reason: pauseReason } : null;
}

export function clearQuotaPause() {
  if (pausedUntil === null) return;
  pausedUntil = null;
  void persistPause();
}

export function isQuotaError(e: unknown): e is QuotaExhaustedError {
  return e instanceof QuotaExhaustedError || (e as Error)?.name === "QuotaExhaustedError";
}

/** Use in fallback catch blocks: quota exhaustion must stop the cycle, not degrade it. */
export function rethrowIfQuota(e: unknown) {
  if (isQuotaError(e)) throw e;
}

/** Read a 429 body; returns a QuotaExhaustedError when it is the gateway saying all keys are spent. */
export function quotaErrorFrom(status: number, body: string): QuotaExhaustedError | null {
  if (status !== 429) return null;
  try {
    const j = JSON.parse(body) as { error?: { code?: string; message?: string; reset_at?: string } };
    const code = j.error?.code;
    const msg = j.error?.message || "";
    if (code === "rate_limited" || /quota/i.test(msg)) {
      return new QuotaExhaustedError(msg || "LLM quota used up", j.error?.reset_at || null);
    }
  } catch { /* not JSON */ }
  return null;
}

/**
 * Ask the LLM gateway whether any key can serve a call right now
 * (GET /v1/availability). Returns null when it can't tell — older gateway
 * without the endpoint, network error — so callers fall back to finding out
 * from a 429 as before.
 */
export async function gatewayAvailability(): Promise<{ available: boolean; nextResetAt: string | null; keys?: Record<string, number> } | null> {
  const { config } = await import("../core/config.js");
  if (config.llm.provider !== "gateway" || !config.llm.gateway.token || !config.llm.gateway.url) return null;
  try {
    const res = await fetch(`${config.llm.gateway.url}/v1/availability`, {
      headers: { Authorization: `Bearer ${config.llm.gateway.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { available?: boolean; nextResetAt?: string | null; keys?: Record<string, number> };
    if (typeof j.available !== "boolean") return null;
    return { available: j.available, nextResetAt: j.nextResetAt ?? null, keys: j.keys };
  } catch {
    return null;
  }
}
