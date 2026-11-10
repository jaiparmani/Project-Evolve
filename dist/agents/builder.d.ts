interface BuildResult {
    filesChanged: string[];
    linesAdded: number;
    linesRemoved: number;
    log: string;
}
export declare function build(workDir: string, implementationPlan: {
    title: string;
    approach: string;
    steps: Array<{
        step: number;
        description: string;
        files: string[];
    }>;
    filesToCreate: string[];
    filesToModify: string[];
    filesToDelete: string[];
}, previousAttempt?: {
    rejectionReason: string;
    feedback: string;
    attempt: number;
}): Promise<BuildResult>;
export {};
//# sourceMappingURL=builder.d.ts.map