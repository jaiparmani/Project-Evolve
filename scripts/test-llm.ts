import { config } from "../src/core/config.js";
import { getClient } from "../src/llm/openrouter.js";

async function test() {
  console.log("LLM Provider:", config.llm.provider);
  console.log("Gateway URL:", config.llm.gateway.url);
  console.log("Token present:", !!config.llm.gateway.token);

  const client = getClient();
  try {
    const res = await client.chat([
      { role: "user", content: "Reply with only the words: hello world" }
    ], { maxTokens: 50 });
    console.log("LLM Response:", res.content.slice(0, 200));
    console.log("Model used:", res.model);
    console.log("Tokens:", res.inputTokens, "+", res.outputTokens);
    console.log("SUCCESS: LLM gateway is working!");
  } catch (e: unknown) {
    console.error("LLM Error:", (e as Error).message);
  }
}
test();
