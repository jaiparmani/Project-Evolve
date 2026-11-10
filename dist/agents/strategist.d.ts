interface Observation {
    category: string;
    description: string;
    severity: string;
    details: string;
    filePath?: string;
    confidence?: number;
    verified?: boolean;
}
interface Idea {
    title: string;
    description: string;
    category: string;
    impact: number;
    confidence: number;
    effort: number;
    strategicValue: number;
    reason: string;
    addressesObservation?: string;
}
interface DismissedFinding {
    observation: string;
    reason: string;
}
interface StrategyResult {
    ideas: Idea[];
    selectedIdea: Idea | null;
    selectionReason: string;
    dismissedFindings: DismissedFinding[];
    flaggedForReview: boolean;
    noActionJustification?: string;
}
export declare function strategize(projectId: string, cycleId: string, observations: {
    observations: Observation[];
    appSummary: string;
    qualityScore: number;
    qualityDimensions?: Record<string, unknown>;
    roadmap?: {
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
    };
}): Promise<StrategyResult>;
export {};
//# sourceMappingURL=strategist.d.ts.map