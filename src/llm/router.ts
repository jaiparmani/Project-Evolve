import { getClient, type LLMMessage, type ModelInfo, RateLimitError } from "./openrouter.js";
import { childLogger } from "../core/logger.js";

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
  plan: [
    "deepseek/deepseek-r1-0528:free",
    "qwen/qwen3-235b-a22b:free",
    "meta-llama/llama-3.3-70b-instruct:free",
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

export async function chatForTask(
  task: TaskType,
  messages: LLMMessage[],
  opts: { maxTokens?: number; jsonMode?: boolean } = {}
) {
  const prefs = MODEL_PREFERENCES[task] || MODEL_PREFERENCES.classify;
  const available = await getAvailableModels();
  const models = prefs.filter(m => available.has(m));
  if (!models.length) models.push("openrouter/auto");

  const client = getClient();
  let lastError: Error | null = null;

  for (const model of models) {
    try {
      log.debug({ task, model }, "Trying model");
      if (opts.jsonMode) {
        return await client.chatJson(messages, { model, maxTokens: opts.maxTokens });
      }
      return await client.chat(messages, { model, maxTokens: opts.maxTokens });
    } catch (err) {
      lastError = err as Error;
      if (err instanceof RateLimitError) {
        log.warn({ task, model }, "Rate limited — trying next model");
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`All models failed for task ${task}`);
}
