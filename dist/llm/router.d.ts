import { type LLMMessage } from "./openrouter.js";
export type TaskType = "observe" | "strategize" | "plan" | "implement" | "review" | "classify" | "summarize";
export declare function selectModel(task: TaskType): Promise<string>;
export declare function chatForTask(task: TaskType, messages: LLMMessage[], opts?: {
    maxTokens?: number;
    jsonMode?: boolean;
}): Promise<import("./openrouter.js").LLMResponse | {
    data: Record<string, unknown>;
    meta: Omit<import("./openrouter.js").LLMResponse, "content">;
}>;
//# sourceMappingURL=router.d.ts.map