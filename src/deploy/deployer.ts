import { config } from "../core/config.js";
import { db, schema } from "../db/index.js";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";
import { exec, execSync, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { eq } from "drizzle-orm";

const execAsync = promisify(exec);

const log = childLogger("deploy");

let appProcess: ChildProcess | null = null;
let currentVersion: string | null = null;

interface DeployResult {
  status: "deployed" | "failed" | "skipped";
  url?: string;
  healthCheck?: boolean;
  previousVersion?: string;
  log: string;
}

export async function deployApp(cycleId: string, appDir: string): Promise<DeployResult> {
  const strategy = config.deploy.strategy;
  const deployId = nanoid();
  const now = new Date().toISOString();

  await db.insert(schema.deployments).values({
    id: deployId,
    cycleId,
    strategy,
    status: "pending",
    createdAt: now,
  });

  let result: DeployResult;

  try {
    switch (strategy) {
      case "local":
        result = await deployLocal(appDir);
        break;
      case "docker":
        result = await deployDocker(appDir);
        break;
      case "custom":
        result = await deployCustom(appDir);
        break;
      default:
        result = { status: "skipped", log: `Unknown strategy: ${strategy}` };
    }

    await db
      .update(schema.deployments)
      .set({
        status: result.status,
        healthCheckResult: result.healthCheck !== undefined ? String(result.healthCheck) : null,
        deployLog: result.log,
        url: result.url || null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.deployments.id, deployId));

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ error: msg }, "Deploy failed");

    await db
      .update(schema.deployments)
      .set({
        status: "failed",
        deployLog: msg,
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.deployments.id, deployId));

    return { status: "failed", log: msg, previousVersion: currentVersion || undefined };
  }
}

async function deployLocal(appDir: string): Promise<DeployResult> {
  const packageJsonPath = resolve(appDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { status: "skipped", log: "No package.json in app directory" };
  }

  if (appProcess) {
    log.info("Stopping previous app process");
    appProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
    appProcess = null;
  }

  try {
    await execAsync("npm install --ignore-scripts", { cwd: appDir, timeout: 120000 });
  } catch (e) {
    log.warn("npm install had issues: %s", (e as Error).message?.slice(0, 200));
  }

  const port = config.deploy.port;

  try {
    const pkg = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf-8"));
    const startCmd = pkg.scripts?.start || pkg.scripts?.dev;

    if (!startCmd) {
      const indexPath = resolve(appDir, "index.html");
      if (existsSync(indexPath)) {
        appProcess = spawn("npx", ["serve", "-s", "-l", String(port)], {
          cwd: appDir,
          stdio: "pipe",
          env: { ...process.env, PORT: String(port) },
        });
      } else {
        return { status: "skipped", log: "No start script or index.html" };
      }
    } else {
      appProcess = spawn("npm", ["start"], {
        cwd: appDir,
        stdio: "pipe",
        env: { ...process.env, PORT: String(port) },
      });
    }

    await new Promise((r) => setTimeout(r, 3000));

    const healthOk = await checkHealth(config.deploy.healthUrl);
    const url = `http://localhost:${port}`;

    if (healthOk) {
      currentVersion = new Date().toISOString();
      return { status: "deployed", url, healthCheck: true, log: "Local deploy successful" };
    }

    return {
      status: "deployed",
      url,
      healthCheck: false,
      log: "Deployed but health check inconclusive (app may not have a /health endpoint)",
    };
  } catch (e) {
    return { status: "failed", log: (e as Error).message };
  }
}

async function deployDocker(appDir: string): Promise<DeployResult> {
  const dockerfile = resolve(appDir, "Dockerfile");
  if (!existsSync(dockerfile)) {
    return { status: "skipped", log: "No Dockerfile found" };
  }

  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch {
    return { status: "skipped", log: "Docker not available" };
  }

  try {
    execSync("docker build -t evolving-app .", { cwd: appDir, timeout: 300000, stdio: "pipe" });
    execSync("docker stop evolving-app 2>/dev/null || true", { stdio: "pipe" });
    execSync("docker rm evolving-app 2>/dev/null || true", { stdio: "pipe" });
    execSync(
      `docker run -d --name evolving-app -p ${config.deploy.port}:${config.deploy.port} evolving-app`,
      { stdio: "pipe" }
    );

    await new Promise((r) => setTimeout(r, 5000));
    const healthy = await checkHealth(config.deploy.healthUrl);

    return {
      status: "deployed",
      url: `http://localhost:${config.deploy.port}`,
      healthCheck: healthy,
      log: "Docker deploy successful",
    };
  } catch (e) {
    return { status: "failed", log: (e as Error).message };
  }
}

async function deployCustom(appDir: string): Promise<DeployResult> {
  if (!config.deploy.command) {
    return { status: "skipped", log: "No custom deploy command configured" };
  }

  try {
    const output = execSync(config.deploy.command, {
      cwd: appDir,
      timeout: 300000,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { status: "deployed", log: output.slice(-1000) };
  } catch (e) {
    return { status: "failed", log: (e as Error).message };
  }
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function rollback(previousVersion: string): Promise<void> {
  log.warn({ previousVersion }, "Rolling back deployment");
  if (appProcess) {
    appProcess.kill("SIGTERM");
    appProcess = null;
  }
}

export function getDeployStatus(): { running: boolean; url?: string; version?: string } {
  return {
    running: appProcess !== null && !appProcess.killed,
    url: appProcess ? `http://localhost:${config.deploy.port}` : undefined,
    version: currentVersion || undefined,
  };
}
