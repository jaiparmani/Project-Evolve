import simpleGit from "simple-git";
import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
const log = childLogger("git");
export class GitManager {
    git;
    appDir;
    constructor(appDir) {
        this.appDir = appDir || config.app.dir;
        if (!existsSync(this.appDir)) {
            mkdirSync(this.appDir, { recursive: true });
        }
        this.git = simpleGit(this.appDir);
    }
    async init() {
        const isRepo = await this.git.checkIsRepo();
        if (!isRepo) {
            await this.git.init();
            log.info("Initialized git repo at %s", this.appDir);
        }
    }
    async ensureBranch(branch) {
        const branches = await this.git.branchLocal();
        if (!branches.all.includes(branch)) {
            await this.git.checkoutLocalBranch(branch);
            log.info("Created branch %s", branch);
        }
        else {
            await this.git.checkout(branch);
        }
    }
    async getCurrentBranch() {
        return (await this.git.branchLocal()).current;
    }
    async getStatus() {
        return this.git.status();
    }
    async createWorktree(cycleId) {
        const worktreeDir = resolve(this.appDir, "..", "worktrees");
        if (!existsSync(worktreeDir))
            mkdirSync(worktreeDir, { recursive: true });
        const branch = `evolve/exp-${cycleId.slice(0, 8)}`;
        const path = resolve(worktreeDir, `exp-${cycleId.slice(0, 8)}`);
        try {
            const currentBranch = await this.getCurrentBranch();
            await this.git.raw(["worktree", "add", "-b", branch, path, currentBranch]);
            log.info({ path, branch }, "Created worktree");
            return { path, branch };
        }
        catch (e) {
            if (existsSync(path)) {
                return { path, branch };
            }
            throw e;
        }
    }
    async removeWorktree(path) {
        try {
            await this.git.raw(["worktree", "remove", path, "--force"]);
        }
        catch {
            log.warn("Could not remove worktree at %s", path);
        }
    }
    async commitChanges(message, worktreePath) {
        const git = worktreePath ? simpleGit(worktreePath) : this.git;
        await git.add("-A");
        const status = await git.status();
        if (status.files.length === 0) {
            throw new Error("No changes to commit");
        }
        const result = await git.commit(message);
        const sha = result.commit || "";
        const diffStat = await git.diffSummary(["HEAD~1", "HEAD"]);
        log.info({ sha, files: diffStat.files_changed ?? diffStat.changed }, "Committed");
        return {
            sha,
            filesChanged: diffStat.files_changed ?? diffStat.changed ?? 0,
            insertions: diffStat.insertions || 0,
            deletions: diffStat.deletions || 0,
        };
    }
    async mergeExperiment(experimentBranch) {
        await this.git.merge([experimentBranch, "--no-ff", "-m", `Merge ${experimentBranch}`]);
    }
    async push(branch) {
        try {
            const targetBranch = branch || await this.getCurrentBranch();
            await this.git.push(config.git.remote, targetBranch);
            log.info("Pushed to %s/%s", config.git.remote, targetBranch);
            return { success: true };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.error("Push failed: %s", msg);
            return { success: false, error: msg };
        }
    }
    async getLog(count = 10) {
        return this.git.log({ maxCount: count });
    }
    async getDiff(from, to) {
        if (from && to) {
            return this.git.diff([from, to]);
        }
        return this.git.diff();
    }
    async getFileList(path) {
        const dir = path || this.appDir;
        const git = simpleGit(dir);
        try {
            const result = await git.raw(["ls-files"]);
            return result.split("\n").filter(Boolean);
        }
        catch {
            return [];
        }
    }
    async readFile(filePath) {
        const { readFileSync } = await import("fs");
        return readFileSync(resolve(this.appDir, filePath), "utf-8");
    }
}
let _manager = null;
export function getGitManager() {
    if (!_manager)
        _manager = new GitManager();
    return _manager;
}
//# sourceMappingURL=manager.js.map