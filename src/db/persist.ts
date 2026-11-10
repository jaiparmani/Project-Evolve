import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { childLogger } from "../core/logger.js";

const log = childLogger("db-persist");
const ROOT = resolve(process.cwd());
const DB_PATH = "data/evolve.db";

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    log.warn({ cmd, error: (e as Error).message?.slice(0, 200) }, "git command failed");
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

  // Convert https://github.com/user/repo.git → https://<token>@github.com/user/repo.git
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

  git(`add -f ${DB_PATH}`);
  const commitResult = git(`commit -m "chore: persist DB after evolution cycle" --no-verify`);
  if (!commitResult) {
    log.warn("Commit failed or nothing to commit");
    return;
  }

  const pushResult = git("push origin main");
  if (pushResult) {
    log.info("DB backed up to git");
  } else {
    log.warn("Push failed — DB backup not persisted");
  }
}
