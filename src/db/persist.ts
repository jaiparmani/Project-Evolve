import { exec, execSync } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { childLogger } from "../core/logger.js";

const execAsync = promisify(exec);
const log = childLogger("db-persist");
const ROOT = resolve(process.cwd());
const DB_PATH = "data/evolve.db";

function gitSync(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString?.()?.trim?.() || "";
    if (e.status === 0) return stderr;
    log.warn({ cmd, error: (stderr || e.message)?.slice(0, 200) }, "git command failed");
    return "";
  }
}

async function git(cmd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`git ${cmd}`, { cwd: ROOT, timeout: 30000 });
    return (stdout || stderr || "").trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString?.()?.trim?.() || "";
    if (e.status === 0) return stderr;
    log.warn({ cmd, error: (stderr || e.message)?.slice(0, 200) }, "git command failed");
    return "";
  }
}

export function restoreDb(): void {
  log.info("Checking for persisted DB in git...");
  gitSync("config user.email \"evolve-bot@project-evolve.app\"");
  gitSync("config user.name \"Project Evolve Bot\"");

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const remoteUrl = gitSync("remote get-url origin");
    if (remoteUrl?.startsWith("https://") && !remoteUrl.includes("@")) {
      gitSync(`remote set-url origin ${remoteUrl.replace("https://", `https://${token}@`)}`);
    }
  }

  gitSync("fetch origin main --depth=1");

  // Always try to restore from git — the local DB is fresh/empty on Render redeploy
  const fileSize = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
  const dbFullPath = resolve(ROOT, DB_PATH);
  const localSize = fileSize(dbFullPath);

  gitSync(`checkout origin/main -- ${DB_PATH}`);
  const restoredSize = fileSize(dbFullPath);

  if (restoredSize > 100) {
    log.info({ restoredSize, previousSize: localSize }, "Restored DB from git");
  } else if (localSize > 0) {
    log.info({ localSize }, "Git DB was empty/missing — keeping local DB");
  } else {
    log.info("No persisted DB found — starting fresh");
  }
}

async function getRepoInfo(): Promise<{ owner: string; repo: string } | null> {
  const url = await git("remote get-url origin");
  log.info({ remoteUrl: url.replace(/\/\/[^@]+@/, "//***@") }, "Parsed remote URL");
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (match) return { owner: match[1], repo: match[2] };
  log.warn("Could not parse remote URL — using hardcoded repo info");
  return { owner: "jaiparmani", repo: "Project-Evolve" };
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

  // Checkpoint WAL so the main .db file has all data
  try {
    const Database = (await import("better-sqlite3")).default;
    const tmpDb = new Database(dbFile, { readonly: false });
    tmpDb.pragma("wal_checkpoint(TRUNCATE)");
    tmpDb.close();
    log.info("WAL checkpointed before backup");
  } catch (e) {
    log.warn({ error: (e as Error).message }, "WAL checkpoint failed — backing up anyway");
  }

  const { owner, repo } = repoInfo;
  log.info({ owner, repo }, "Backing up DB via GitHub API...");

  const content = readFileSync(dbFile).toString("base64");
  if (!content || content.length < 100) {
    log.warn({ size: content.length }, "DB file appears empty/tiny — skipping backup");
    return;
  }
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${DB_PATH}`;

  try {
    // Get current file SHA (needed for updates, 422 without it)
    let sha: string | undefined;
    const getRes = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (getRes.ok) {
      const data = await getRes.json() as { sha: string };
      sha = data.sha;
      log.info({ sha: sha.slice(0, 8) }, "Found existing DB on GitHub");
    } else {
      log.info({ status: getRes.status }, "No existing DB on GitHub — will create");
    }

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
      log.info("DB backed up to GitHub via API successfully");
    } else {
      const errText = await putRes.text();
      log.error({ status: putRes.status, error: errText.slice(0, 500) }, "GitHub API push failed");
    }
  } catch (e) {
    log.error({ error: (e as Error).message, stack: (e as Error).stack?.slice(0, 300) }, "DB backup failed");
  }
}

export async function pushEvolvedFiles(appDir: string, filesChanged: string[]): Promise<{ success: boolean; error?: string }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { success: false, error: "GITHUB_TOKEN not set" };

  const repoInfo = getRepoInfo();
  if (!repoInfo) return { success: false, error: "Could not determine repo" };

  const { owner, repo } = repoInfo;
  log.info({ owner, repo, files: filesChanged.length }, "Pushing evolved files via GitHub API");

  let pushed = 0;
  for (const file of filesChanged) {
    const filePath = resolve(appDir, file);
    if (!existsSync(filePath)) continue;

    const repoPath = `evolving-app/${file}`;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`;
    const content = readFileSync(filePath).toString("base64");

    try {
      let sha: string | undefined;
      const getRes = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10000),
      });
      if (getRes.ok) {
        sha = ((await getRes.json()) as { sha: string }).sha;
      }

      const putRes = await fetch(apiUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `feat(evolve): update ${file} [auto-evolved]`,
          content,
          branch: "main",
          ...(sha ? { sha } : {}),
          committer: { name: "Project Evolve Bot", email: "evolve-bot@project-evolve.app" },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (putRes.ok) {
        pushed++;
        log.info({ file: repoPath }, "Pushed evolved file");
      } else {
        const errText = await putRes.text();
        log.warn({ file: repoPath, status: putRes.status, error: errText.slice(0, 200) }, "Failed to push file");
      }
    } catch (e) {
      log.warn({ file: repoPath, error: (e as Error).message }, "Error pushing file");
    }
  }

  log.info({ pushed, total: filesChanged.length }, "Evolved files push complete");
  return { success: pushed > 0 };
}
