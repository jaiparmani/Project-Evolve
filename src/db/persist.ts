import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { childLogger } from "../core/logger.js";

const log = childLogger("db-persist");
const ROOT = resolve(process.cwd());
const DB_PATH = "data/evolve.db";

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString?.()?.trim?.() || "";
    const stdout = e.stdout?.toString?.()?.trim?.() || "";
    // git push/fetch write progress to stderr even on success — check exit code
    if (e.status === 0) return stdout || stderr;
    log.warn({ cmd, error: (stderr || e.message)?.slice(0, 300) }, "git command failed");
    return "";
  }
}

function configureAuth(): boolean {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log.warn("GITHUB_TOKEN not set — DB backup to git disabled");
    return false;
  }

  const remoteUrl = git("remote get-url origin");
  if (!remoteUrl) return false;

  if (remoteUrl.startsWith("https://") && !remoteUrl.includes("@")) {
    const authedUrl = remoteUrl.replace("https://", `https://${token}@`);
    git(`remote set-url origin ${authedUrl}`);
    log.info("Configured git remote with token auth");
  }

  return true;
}

export function restoreDb(): void {
  log.info("Checking for persisted DB in git...");
  git("config user.email \"evolve-bot@project-evolve.app\"");
  git("config user.name \"Project Evolve Bot\"");
  configureAuth();
  git("fetch origin main --depth=1");

  if (!existsSync(resolve(ROOT, DB_PATH))) {
    git(`checkout origin/main -- ${DB_PATH}`);
    if (existsSync(resolve(ROOT, DB_PATH))) {
      log.info("Restored DB from git");
    } else {
      log.info("No persisted DB found — starting fresh");
    }
  } else {
    log.info("DB already exists locally");
  }
}

export function backupDb(): void {
  if (!existsSync(resolve(ROOT, DB_PATH))) {
    log.warn("No DB file to back up");
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log.warn("GITHUB_TOKEN not set — skipping DB backup");
    return;
  }

  const status = git(`status --porcelain ${DB_PATH}`);
  if (!status) {
    log.debug("DB unchanged — skipping backup");
    return;
  }

  // Render deploys in detached HEAD — create a temp branch for the commit
  git("checkout -B __db-backup");
  git(`add -f ${DB_PATH}`);
  const commitResult = git(`commit -m "chore: persist DB after evolution cycle" --no-verify`);
  if (!commitResult) {
    log.warn("Commit failed or nothing to commit");
    return;
  }

  // Fetch enough history so push doesn't get rejected
  git("fetch origin main --depth=10");
  // Rebase our commit on top of remote main to avoid conflicts
  git("rebase origin/main");
  // Push our temp branch to remote main
  const pushResult = git("push origin __db-backup:main");
  log.info({ result: pushResult?.slice(0, 200) }, "DB backup push attempted");
}
