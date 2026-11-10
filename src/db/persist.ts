import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { childLogger } from "../core/logger.js";

const log = childLogger("db-persist");
const ROOT = resolve(process.cwd());
const DB_PATH = "data/evolve.db";

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString?.()?.trim?.() || "";
    if (e.status === 0) return stderr;
    log.warn({ cmd, error: (stderr || e.message)?.slice(0, 200) }, "git command failed");
    return "";
  }
}

export function restoreDb(): void {
  log.info("Checking for persisted DB in git...");
  git("config user.email \"evolve-bot@project-evolve.app\"");
  git("config user.name \"Project Evolve Bot\"");

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const remoteUrl = git("remote get-url origin");
    if (remoteUrl?.startsWith("https://") && !remoteUrl.includes("@")) {
      git(`remote set-url origin ${remoteUrl.replace("https://", `https://${token}@`)}`);
    }
  }

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

function getRepoInfo(): { owner: string; repo: string } | null {
  const url = git("remote get-url origin");
  // Match https://github.com/owner/repo.git or https://token@github.com/owner/repo.git
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export async function backupDb(): Promise<void> {
  const dbFile = resolve(ROOT, DB_PATH);
  if (!existsSync(dbFile)) {
    log.warn("No DB file to back up");
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log.warn("GITHUB_TOKEN not set — skipping DB backup");
    return;
  }

  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    log.warn("Could not parse GitHub repo from remote URL");
    return;
  }

  const { owner, repo } = repoInfo;
  const content = readFileSync(dbFile).toString("base64");
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${DB_PATH}`;

  try {
    // Get current file SHA (needed for updates)
    let sha: string | undefined;
    try {
      const getRes = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (getRes.ok) {
        const data = await getRes.json() as { sha: string };
        sha = data.sha;
      }
    } catch {
      // File might not exist yet — that's fine
    }

    const body: Record<string, string> = {
      message: "chore: persist DB after evolution cycle",
      content,
      branch: "main",
      committer: JSON.stringify({ name: "Project Evolve Bot", email: "evolve-bot@project-evolve.app" }),
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "chore: persist DB after evolution cycle",
        content,
        branch: "main",
        ...(sha ? { sha } : {}),
        committer: { name: "Project Evolve Bot", email: "evolve-bot@project-evolve.app" },
      }),
    });

    if (putRes.ok) {
      log.info("DB backed up to GitHub via API");
    } else {
      const errText = await putRes.text();
      log.warn({ status: putRes.status, error: errText.slice(0, 300) }, "GitHub API push failed");
    }
  } catch (e) {
    log.warn({ error: (e as Error).message }, "DB backup failed");
  }
}
