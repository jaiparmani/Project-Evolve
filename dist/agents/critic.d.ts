interface CheckResult {
    passed: boolean;
    output: string;
}
interface CodeReview {
    approved: boolean;
    feedback: string;
    qualityScore: number;
    findings: Array<{
        issue: string;
        severity: string;
        confidence: number;
        filePath?: string;
    }>;
}
interface EvaluationResult {
    typescriptCheck: CheckResult;
    buildCheck: CheckResult;
    testCheck: CheckResult;
    codeReview: CodeReview;
    overallPassed: boolean;
    rejectionReason?: string;
}
export declare function evaluate(workDir: string, changes: {
    filesChanged: string[];
    log: string;
}, idea: {
    title: string;
    description: string;
}): Promise<EvaluationResult>;
export {};
//# sourceMappingURL=critic.d.ts.map