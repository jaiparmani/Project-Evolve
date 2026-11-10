interface DeployResult {
    status: "deployed" | "failed" | "skipped";
    url?: string;
    healthCheck?: boolean;
    previousVersion?: string;
    log: string;
}
export declare function deployApp(cycleId: string, appDir: string): Promise<DeployResult>;
export declare function rollback(previousVersion: string): Promise<void>;
export declare function getDeployStatus(): {
    running: boolean;
    url?: string;
    version?: string;
};
export {};
//# sourceMappingURL=deployer.d.ts.map