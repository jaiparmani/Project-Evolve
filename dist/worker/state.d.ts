export type EvolutionMode = "foundation" | "features" | "quality" | "polish";
export declare function getEvolutionMode(): EvolutionMode;
export declare function setEvolutionMode(mode: EvolutionMode): void;
export declare function loadEvolutionModeFromDb(): Promise<void>;
export declare function getWorkerStatus(): {
    isRunning: boolean;
    currentCycleId: string | null;
    cyclesRanToday: number;
    maxCyclesPerDay: number;
    intervalMinutes: number;
    loopActive: boolean;
};
export declare function setRunning(val: boolean): void;
export declare function getRunning(): boolean;
export declare function setCycleId(id: string | null): void;
export declare function incrementCycles(): void;
export declare function canRunCycle(): boolean;
export declare function isLoopActive(): boolean;
export declare function startLoop(runOneCycle: () => Promise<void>): void;
export declare function stopLoop(): void;
//# sourceMappingURL=state.d.ts.map