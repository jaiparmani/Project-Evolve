import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { childLogger } from "../core/logger.js";
const log = childLogger("db-persist");
const ROOT = resolve(process.cwd());
const DB_PATH = "data/evolve.db";
function git(cmd) {
    try {
        return execSync(`git ${cmd}`, { cwd: ROOT, timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    }
    catch (e) {
        const stderr = e.stderr?.toString?.()?.trim?.() || "";
        if (e.status === 0)
            return stderr;
        log.warn({ cmd, error: (stderr || e.message)?.slice(0, 200) }, "git command failed");
        return "";
    }
}
export function restoreDb() {
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
        }
        else {
            log.info("No persisted DB found — starting fresh");
        }
    }
    else {
        log.info("DB already exists locally");
    }
}
function getRepoInfo() {
    const url = git("remote get-url origin");
    log.info({ remoteUrl: url.replace(/\/\/[^@]+@/, "//***@") }, "Parsed remote URL");
    const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (match)
        return { owner: match[1], repo: match[2] };
    // Fallback: hardcoded for Render where git remote may be unreliable
    log.warn("Could not parse remote URL — using hardcoded repo info");
    return { owner: "jaiparmani", repo: "Project-Evolve" };
}
export async function backupDb() {
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
    log.info({ owner, repo }, "Backing up DB via GitHub API...");
    const content = readFileSync(dbFile).toString("base64");
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${DB_PATH}`;
    try {
        // Get current file SHA (needed for updates, 422 without it)
        let sha;
        const getRes = await fetch(apiUrl, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.v3+json",
            },
        });
        if (getRes.ok) {
            const data = await getRes.json();
            sha = data.sha;
            log.info({ sha: sha.slice(0, 8) }, "Found existing DB on GitHub");
        }
        else {
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
        }
        else {
            const errText = await putRes.text();
            log.error({ status: putRes.status, error: errText.slice(0, 500) }, "GitHub API push failed");
        }
    }
    catch (e) {
        log.error({ error: e.message, stack: e.stack?.slice(0, 300) }, "DB backup failed");
    }
}
//# sourceMappingURL=persist.js.map