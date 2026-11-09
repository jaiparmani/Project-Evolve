import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

loadEnv();

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env: ${key}`);
  return v;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

export const config = {
  llm: {
    provider: env("LLM_PROVIDER", "gateway") as "gateway" | "openrouter" | "direct",
    gateway: {
      url: env("LLM_GATEWAY_URL", "https://llm-gateway.brain-store.workers.dev"),
      token: env("LLM_GATEWAY_TOKEN", ""),
    },
    openrouter: {
      apiKey: env("OPENROUTER_API_KEY", ""),
      baseUrl: "https://openrouter.ai/api/v1",
    },
    model: env("LLM_MODEL", ""),
  },

  db: {
    url: env("DATABASE_URL", `sqlite://./data/evolve.db`),
  },

  git: {
    branch: env("EVOLVE_BRANCH", "evolve/auto"),
    remote: env("GITHUB_REMOTE", "origin"),
  },

  evolution: {
    intervalMinutes: envInt("EVOLVE_INTERVAL_MINUTES", 30),
    maxCyclesPerDay: envInt("EVOLVE_MAX_CYCLES_PER_DAY", 48),
    maxRequestsPerCycle: envInt("EVOLVE_MAX_REQUESTS_PER_CYCLE", 20),
    maxTokensPerCycle: envInt("EVOLVE_MAX_TOKENS_PER_CYCLE", 50000),
    dailyBudgetUsd: parseFloat(env("EVOLVE_DAILY_BUDGET_USD", "0")),
  },

  server: {
    port: envInt("PORT", 3000),
    nodeEnv: env("NODE_ENV", "development"),
  },

  app: {
    dir: resolve(process.cwd(), env("EVOLVE_APP_DIR", "./evolving-app")),
  },

  deploy: {
    strategy: env("DEPLOY_STRATEGY", "local") as "local" | "docker" | "custom",
    port: envInt("DEPLOY_PORT", 3001),
    healthUrl: env("DEPLOY_HEALTH_URL", "http://localhost:3001/health"),
    command: env("DEPLOY_COMMAND", ""),
  },
} as const;
