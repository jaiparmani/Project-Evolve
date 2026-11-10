export interface LLMMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface LLMResponse {
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
}
export interface ModelInfo {
    id: string;
    name: string;
    contextLength: number;
    pricing: {
        prompt: string;
        completion: string;
    };
}
export declare class LLMClient {
    private requestCount;
    private totalTokens;
    private lastCallTime;
    private static readonly MIN_CALL_INTERVAL_MS;
    get stats(): {
        requests: number;
        tokens: number;
    };
    private throttle;
    listFreeModels(): Promise<ModelInfo[]>;
    chat(messages: LLMMessage[], opts?: {
        model?: string;
        maxTokens?: number;
        temperature?: number;
        jsonMode?: boolean;
        timeout?: number;
    }): Promise<LLMResponse>;
    chatJson<T = Record<string, unknown>>(messages: LLMMessage[], opts?: {
        model?: string;
        maxTokens?: number;
        expectKey?: string;
        maxAttempts?: number;
    }): Promise<{
        data: T;
        meta: Omit<LLMResponse, "content">;
    }>;
}
export declare class LLMError extends Error {
    constructor(message: string);
}
export declare class RateLimitError extends LLMError {
    constructor(message: string);
}
export declare function getClient(): LLMClient;
//# sourceMappingURL=openrouter.d.ts.map