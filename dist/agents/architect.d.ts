interface ImplementationPlan {
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
    acceptanceCriteria: string[];
    regressionRisks: string[];
    estimatedComplexity: "low" | "medium" | "high";
}
export declare function plan(appDir: string, selectedIdea: {
    title: string;
    description: string;
    category: string;
}, observations: {
    appSummary: string;
}): Promise<ImplementationPlan>;
export {};
//# sourceMappingURL=architect.d.ts.map