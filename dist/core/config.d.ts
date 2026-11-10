export declare const config: {
    readonly llm: {
        readonly provider: "gateway" | "openrouter" | "direct";
        readonly gateway: {
            readonly url: string;
            readonly token: string;
        };
        readonly openrouter: {
            readonly apiKey: string;
            readonly baseUrl: "https://openrouter.ai/api/v1";
        };
        readonly model: string;
    };
    readonly db: {
        readonly url: string;
    };
    readonly git: {
        readonly branch: string;
        readonly remote: string;
    };
    readonly evolution: {
        readonly intervalMinutes: number;
        readonly maxCyclesPerDay: number;
        readonly maxRequestsPerCycle: number;
        readonly maxTokensPerCycle: number;
        readonly dailyBudgetUsd: number;
        readonly maxBuildRetries: number;
    };
    readonly server: {
        readonly port: number;
        readonly nodeEnv: string;
    };
    readonly app: {
        readonly dir: string;
    };
    readonly deploy: {
        readonly strategy: "local" | "docker" | "custom";
        readonly port: number;
        readonly healthUrl: string;
        readonly command: string;
    };
};
//# sourceMappingURL=config.d.ts.map