interface Observation {
    category: string;
    description: string;
    severity: "low" | "medium" | "high" | "critical";
    details: string;
    filePath?: string;
    lineRange?: string;
    confidence: number;
    verified: boolean;
}
interface QualityDimensions {
    [key: string]: number | null | undefined;
    functionality: number | null;
    correctness: number | null;
    accessibility: number | null;
    performance: number | null;
    security: number | null;
    testCoverage: number | null;
    reliability: number | null;
}
interface RoadmapContext {
    currentStageId: string;
    currentStageName: string;
    currentStageGoals: string[];
    stageProgress: Array<{
        id: string;
        name: string;
        percentComplete: number;
        isComplete: boolean;
    }>;
    overallProgress: number;
    failingGates: string[];
}
interface ObservationResult {
    observations: Observation[];
    appSummary: string;
    qualityScore: number;
    qualityDimensions: QualityDimensions;
    roadmap: RoadmapContext;
}
export declare function observe(projectId: string, cycleId: string, appDir: string): Promise<ObservationResult>;
export {};
//# sourceMappingURL=observer.d.ts.map