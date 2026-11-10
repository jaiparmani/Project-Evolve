import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
const log = childLogger("llm");
function getEndpoint() {
    const provider = config.llm.provider;
    if (provider === "gateway" && config.llm.gateway.token) {
        return {
            url: `${config.llm.gateway.url}/v1/chat/completions`,
            headers: {
                Authorization: `Bearer ${config.llm.gateway.token}`,
                "Content-Type": "application/json",
            },
        };
    }
    if (config.llm.openrouter.apiKey) {
        return {
            url: `${config.llm.openrouter.baseUrl}/chat/completions`,
            headers: {
                Authorization: `Bearer ${config.llm.openrouter.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://project-evolve.local",
                "X-Title": "Project Evolve",
            },
        };
    }
    if (config.llm.gateway.url) {
        return {
            url: `${config.llm.gateway.url}/v1/chat/completions`,
            headers: {
                Authorization: `Bearer ${config.llm.gateway.token}`,
                "Content-Type": "application/json",
            },
        };
    }
    throw new Error("No LLM provider configured. Set LLM_GATEWAY_TOKEN or OPENROUTER_API_KEY.");
}
export class LLMClient {
    requestCount = 0;
    totalTokens = 0;
    lastCallTime = 0;
    static MIN_CALL_INTERVAL_MS = 2000;
    get stats() {
        return { requests: this.requestCount, tokens: this.totalTokens };
    }
    async throttle() {
        const elapsed = Date.now() - this.lastCallTime;
        if (elapsed < LLMClient.MIN_CALL_INTERVAL_MS) {
            await new Promise(r => setTimeout(r, LLMClient.MIN_CALL_INTERVAL_MS - elapsed));
        }
        this.lastCallTime = Date.now();
    }
    async listFreeModels() {
        try {
            const res = await fetch("https://openrouter.ai/api/v1/models");
            if (!res.ok)
                return [];
            const data = (await res.json());
            return data.data.filter((m) => m.id.includes(":free") ||
                (m.pricing?.prompt === "0" && m.pricing?.completion === "0"));
        }
        catch {
            log.warn("Could not fetch models list");
            return [];
        }
    }
    async chat(messages, opts = {}) {
        const { url, headers } = getEndpoint();
        const model = opts.model || config.llm.model || "";
        const body = {
            messages,
            max_tokens: opts.maxTokens || 4096,
            temperature: opts.temperature ?? 0.7,
        };
        if (model)
            body.model = model;
        // Disabled response_format as many free models don't support it and return 500
        // JSON extraction from plain text is handled by extractJson()
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), opts.timeout || 60000);
        try {
            await this.throttle();
            log.debug({ url, model }, "LLM request");
            const res = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (res.status === 429 || res.status >= 500) {
                const text = await res.text();
                for (let retry = 0; retry < 3; retry++) {
                    const baseDelay = res.status === 429 ? 10000 : 5000;
                    const delay = baseDelay * Math.pow(2, retry);
                    log.warn({ status: res.status, retry: retry + 1, delayMs: delay }, "Error, retrying");
                    await new Promise(r => setTimeout(r, delay));
                    try {
                        const retryRes = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
                        if (retryRes.ok) {
                            const retryData = (await retryRes.json());
                            const retryChoices = retryData.choices || [];
                            if (retryChoices.length) {
                                const retryContent = retryChoices[0]?.message?.content || "";
                                const retryUsage = retryData.usage || {};
                                this.requestCount++;
                                this.totalTokens += (retryUsage.prompt_tokens || 0) + (retryUsage.completion_tokens || 0);
                                return {
                                    content: retryContent,
                                    model: retryData.model || model || "unknown",
                                    inputTokens: retryUsage.prompt_tokens || 0,
                                    outputTokens: retryUsage.completion_tokens || 0,
                                    estimatedCost: 0,
                                };
                            }
                        }
                        if (retryRes.status === 429) {
                            log.warn({ retry: retry + 1 }, "Still rate limited, backing off more");
                        }
                    }
                    catch { }
                }
                if (res.status === 429) {
                    throw new RateLimitError(`Rate limited after 3 retries: ${text.slice(0, 300)}`);
                }
                throw new LLMError(`LLM ${res.status} after 3 retries: ${text.slice(0, 300)}`);
            }
            if (!res.ok) {
                const text = await res.text();
                throw new LLMError(`LLM ${res.status}: ${text.slice(0, 300)}`);
            }
            const data = (await res.json());
            const choices = data.choices || [];
            if (!choices.length)
                throw new LLMError("No choices returned");
            const content = choices[0]?.message?.content || "";
            const usage = data.usage || {};
            this.requestCount++;
            this.totalTokens += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
            return {
                content,
                model: data.model || model || "unknown",
                inputTokens: usage.prompt_tokens || 0,
                outputTokens: usage.completion_tokens || 0,
                estimatedCost: 0,
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async chatJson(messages, opts = {}) {
        const maxAttempts = opts.maxAttempts || 2;
        let lastError = null;
        let msgs = [...messages];
        for (let i = 0; i < maxAttempts; i++) {
            const res = await this.chat(msgs, {
                model: opts.model,
                maxTokens: opts.maxTokens,
                jsonMode: true,
            });
            try {
                const parsed = extractJson(res.content, opts.expectKey);
                return {
                    data: parsed,
                    meta: {
                        model: res.model,
                        inputTokens: res.inputTokens,
                        outputTokens: res.outputTokens,
                        estimatedCost: res.estimatedCost,
                    },
                };
            }
            catch (e) {
                lastError = e;
                msgs = [
                    ...messages,
                    { role: "assistant", content: res.content.slice(0, 1000) },
                    {
                        role: "user",
                        content: "That was not valid JSON. Reply with ONLY a JSON object, no prose or code fences.",
                    },
                ];
            }
        }
        throw lastError || new LLMError("Failed to get valid JSON");
    }
}
export class LLMError extends Error {
    constructor(message) {
        super(message);
        this.name = "LLMError";
    }
}
export class RateLimitError extends LLMError {
    constructor(message) {
        super(message);
        this.name = "RateLimitError";
    }
}
function extractJson(text, expectKey) {
    let cleaned = text.replace(/<think>.*?<\/think>/gis, "");
    cleaned = cleaned.replace(/```(?:json)?|```/g, "");
    try {
        const parsed = JSON.parse(cleaned);
        if (typeof parsed === "object" && parsed !== null)
            return parsed;
    }
    catch { }
    const spans = jsonSpans(cleaned);
    let fallback = null;
    for (const span of spans) {
        try {
            const parsed = JSON.parse(span);
            if (typeof parsed !== "object" || parsed === null)
                continue;
            if (!expectKey || expectKey in parsed)
                return parsed;
            if (!fallback)
                fallback = parsed;
        }
        catch { }
    }
    if (fallback)
        return fallback;
    throw new LLMError("Could not extract JSON from response");
}
function jsonSpans(text) {
    const spans = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === "\\")
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"')
            inString = true;
        else if (ch === "{") {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (ch === "}") {
            if (depth > 0) {
                depth--;
                if (depth === 0 && start >= 0)
                    spans.push(text.slice(start, i + 1));
            }
        }
    }
    return spans;
}
let _client = null;
export function getClient() {
    if (!_client)
        _client = new LLMClient();
    return _client;
}
//# sourceMappingURL=openrouter.js.map