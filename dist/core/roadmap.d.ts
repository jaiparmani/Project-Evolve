export interface StageGate {
    id: string;
    check: (appDir: string) => boolean;
    description: string;
}
export interface RoadmapStage {
    id: string;
    name: string;
    description: string;
    priority: number;
    goals: string[];
    categories: string[];
    gates: StageGate[];
}
export declare const ROADMAP: RoadmapStage[];
export interface StageStatus {
    stage: RoadmapStage;
    gateResults: Array<{
        gate: StageGate;
        passed: boolean;
    }>;
    completedGates: number;
    totalGates: number;
    percentComplete: number;
    isComplete: boolean;
}
export declare function evaluateRoadmap(appDir: string): {
    currentStage: RoadmapStage;
    stageStatuses: StageStatus[];
    overallProgress: number;
};
//# sourceMappingURL=roadmap.d.ts.map