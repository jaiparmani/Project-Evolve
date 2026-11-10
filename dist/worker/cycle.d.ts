interface CycleResult {
    cycleId: string;
    status: "completed" | "failed" | "rejected";
    improvement?: string;
    commitSha?: string;
    pushStatus?: string;
    deployStatus?: string;
    qualityBefore?: number;
    qualityAfter?: number;
    tokensUsed: number;
    error?: string;
}
export declare function runCycle(projectId: string): Promise<CycleResult>;
export {};
//# sourceMappingURL=cycle.d.ts.map