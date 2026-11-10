export declare class GitManager {
    private git;
    private appDir;
    constructor(appDir?: string);
    init(): Promise<void>;
    ensureBranch(branch: string): Promise<void>;
    getCurrentBranch(): Promise<string>;
    getStatus(): Promise<import("simple-git").StatusResult>;
    createWorktree(cycleId: string): Promise<{
        path: string;
        branch: string;
    }>;
    removeWorktree(path: string): Promise<void>;
    commitChanges(message: string, worktreePath?: string): Promise<{
        sha: string;
        filesChanged: number;
        insertions: number;
        deletions: number;
    }>;
    mergeExperiment(experimentBranch: string): Promise<void>;
    push(branch?: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    getLog(count?: number): Promise<import("simple-git").LogResult<import("simple-git").DefaultLogFields>>;
    getDiff(from?: string, to?: string): Promise<string>;
    getFileList(path?: string): Promise<string[]>;
    readFile(filePath: string): Promise<string>;
}
export declare function getGitManager(): GitManager;
//# sourceMappingURL=manager.d.ts.map