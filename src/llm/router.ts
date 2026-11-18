import { getClient, type LLMMessage, type ModelInfo, RateLimitError } from "./openrouter.js";
import { QuotaExhaustedError, isQuotaError, pauseForQuota, quotaPause } from "./quota.js";
import { childLogger } from "../core/logger.js";
import { config } from "../core/config.js";

const log = childLogger("model-router");

export type TaskType =
  | "observe"
  | "strategize"
  | "plan"
  | "implement"
  | "review"
  | "classify"
  | "summarize";

const MODEL_PREFERENCES: Record<TaskType, string[]> = {
  observe: [
    "google/gemma-3-27b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-235b-a22b:free",
  ],
  strategize: [
    "deepseek/deepseek-r1-0528:free",
    "qwen/qwen3-235b-a22b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ],
  // Planning returns a large JSON document from a big prompt; the reasoning
  // model is accurate but routinely times out, so it goes last.
  plan: [
    "qwen/qwen3-235b-a22b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-r1-0528:free",
  ],
  implement: [
    "qwen/qwen3-235b-a22b:free",
    "deepseek/deepseek-r1-0528:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ],
  review: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-235b-a22b:free",
    "google/gemma-3-27b-it:free",
  ],
  classify: [
    "google/gemma-3-12b-it:free",
    "google/gemma-3-27b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ],
  summarize: [
    "google/gemma-3-12b-it:free",
    "google/gemma-3-27b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ],
};

let cachedModels: ModelInfo[] | null = null;
let lastFetch = 0;

async function getAvailableModels(): Promise<Set<string>> {
  if (cachedModels && Date.now() - lastFetch < 3600_000) {
    return new Set(cachedModels.map((m) => m.id));
  }
  const client = getClient();
  cachedModels = await client.listFreeModels();
  lastFetch = Date.now();
  return new Set(cachedModels.map((m) => m.id));
}

export async function selectModel(task: TaskType): Promise<string> {
  const available = await getAvailableModels();
  const prefs = MODEL_PREFERENCES[task] || MODEL_PREFERENCES.classify;

  for (const model of prefs) {
    if (available.has(model)) {
      log.debug({ task, model }, "Selected model");
      return model;
    }
  }

  if (available.size > 0) {
    const fallback = [...available][0];
    log.warn({ task, fallback }, "No preferred model available, using fallback");
    return fallback;
  }

  return "openrouter/auto";
}

export interface TaskAttemptError { model: string; error: string; ms: number }

/** Errors from the last chatForTask call per task, so callers can record why a step degraded. */
export const lastTaskErrors: Partial<Record<TaskType, TaskAttemptError[]>> = {};

async function recordUsage(task: TaskType, model: string, meta: { inputTokens?: number; outputTokens?: number }, ms: number) {
  try {
    const [{ db, schema }, { getWorkerStatus }, { nanoid }] = await Promise.all([
      import("../db/index.js"), import("../worker/state.js"), import("nanoid"),
    ]);
    await db.insert(schema.modelUsage).values({
      id: nanoid(),
      cycleId: getWorkerStatus().currentCycleId || null,
      agent: task,
      model,
      inputTokens: meta.inputTokens || 0,
      outputTokens: meta.outputTokens || 0,
      estimatedCost: 0,
      durationMs: Math.round(ms),
      createdAt: new Date().toISOString(),
    });
  } catch { /* usage tracking must never break a cycle */ }
}

/**
 * Which models to try for a task, in order.
 *
 * Through the LLM gateway we pin nothing: the gateway rotates keys across
 * several free providers, picks a live model for each, and salvages bad JSON.
 * Pinning a model id (as this used to) forces every OpenRouter key onto that
 * one model, and the hard-coded free models here have since been retired.
 * An empty model means "gateway decides"; each retry lands on another key.
 */
async function modelsForTask(task: TaskType): Promise<string[]> {
  if (config.llm.provider === "gateway" && config.llm.gateway.token) {
    return config.llm.model ? [config.llm.model, "", ""] : ["", "", ""];
  }
  const prefs = MODEL_PREFERENCES[task] || MODEL_PREFERENCES.classify;
  const available = await getAvailableModels();
  const models = available.size ? prefs.filter((m) => available.has(m)) : [...prefs];
  // openrouter/free routes to whichever free model is up; openrouter/auto is paid.
  if (!models.includes("openrouter/free")) models.push("openrouter/free");
  return models;
}

/**
 * Run a task against its preferred models in order. Any failure — rate limit,
 * timeout, 5xx, unparseable JSON — moves on to the next model, so one slow or
 * flaky free model no longer sinks the whole step.
 */
export async function chatForTask(
  task: TaskType,
  messages: LLMMessage[],
  opts: { maxTokens?: number; jsonMode?: boolean; timeoutMs?: number } = {}
) {
  const pause = quotaPause();
  if (pause) throw new QuotaExhaustedError(`LLM quota used up until ${pause.until}: ${pause.reason}`, pause.until);
  const models = await modelsForTask(task);
  const client = getClient();
  const errors: TaskAttemptError[] = [];
  lastTaskErrors[task] = errors;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const t0 = Date.now();
    try {
      log.info({ task, model: model || "gateway-default", attempt: i + 1, total: models.length }, "Trying model");
      if (opts.jsonMode) {
        const res = await client.chatJson(messages, { model, maxTokens: opts.maxTokens, timeout: opts.timeoutMs });
        void recordUsage(task, res.meta.model || model, res.meta, Date.now() - t0);
        return res;
      }
      const res = await client.chat(messages, { model, maxTokens: opts.maxTokens, timeout: opts.timeoutMs });
      void recordUsage(task, res.model || model, res, Date.now() - t0);
      return res;
    } catch (err) {
      if (isQuotaError(err)) {
        pauseForQuota(err);
        log.warn({ task, resetAt: err.resetAt }, "LLM quota used up — pausing until it resets");
        throw err;
      }
      const e = err as Error;
      const msg = e.name === "AbortError" ? `timed out after ${Math.round((Date.now() - t0) / 1000)}s` : e.message;
      errors.push({ model: model || "gateway", error: msg.slice(0, 300), ms: Date.now() - t0 });
      log.warn({ task, model, error: msg.slice(0, 200), remaining: models.length - i - 1 }, "Model failed — trying next");
      if (err instanceof RateLimitError && i < models.length - 1) await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const summary = errors.map((e) => `${e.model}: ${e.error}`).join(" | ");
  throw new Error(`All models failed for ${task}: ${summary}`.slice(0, 1000));
}
