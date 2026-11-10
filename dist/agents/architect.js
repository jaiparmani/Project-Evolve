import { chatForTask } from "../llm/router.js";
import { childLogger } from "../core/logger.js";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
const log = childLogger("architect");
function getProjectStructure(dir, depth = 3, prefix = "") {
    const result = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist")
                continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            result.push(rel);
            if (entry.isDirectory() && depth > 1) {
                result.push(...getProjectStructure(resolve(dir, entry.name), depth - 1, rel));
            }
        }
    }
    catch { }
    return result;
}
function readRelevantFiles(dir, fileList) {
    const parts = [];
    for (const f of fileList.slice(0, 8)) {
        try {
            const full = resolve(dir, f);
            const content = readFileSync(full, "utf-8");
            parts.push(`--- ${f} ---\n${content.slice(0, 2000)}`);
        }
        catch { }
    }
    return parts.join("\n\n");
}
export async function plan(appDir, selectedIdea, observations) {
    log.info({ idea: selectedIdea.title }, "Planning implementation");
    const structure = getProjectStructure(appDir);
    const keyFiles = structure.filter((f) => f.endsWith("package.json") ||
        f.endsWith("tsconfig.json") ||
        f.endsWith(".tsx") ||
        f.endsWith(".ts") ||
        f.endsWith("index.html") ||
        f.endsWith(".css"));
    const fileContents = readRelevantFiles(appDir, keyFiles);
    const prompt = `You are a software architect. Create a detailed implementation plan.

APPLICATION SUMMARY: ${observations.appSummary}

PROJECT STRUCTURE:
${structure.join("\n")}

KEY FILES:
${fileContents.slice(0, 4000)}

SELECTED IMPROVEMENT:
Title: ${selectedIdea.title}
Description: ${selectedIdea.description}
Category: ${selectedIdea.category}

Create a precise implementation plan. Return JSON:
{
  "title": "Plan title",
  "approach": "Technical approach description",
  "steps": [
    { "step": 1, "description": "What to do", "files": ["path/to/file"] }
  ],
  "filesToCreate": ["new/file.ts"],
  "filesToModify": ["existing/file.ts"],
  "filesToDelete": [],
  "acceptanceCriteria": ["The thing works", "Tests pass"],
  "regressionRisks": ["Might break X"],
  "estimatedComplexity": "low|medium|high"
}

Be specific about file paths and changes. Keep it minimal and focused.`;
    try {
        const result = await chatForTask("plan", [
            { role: "system", content: "You are a senior software architect. Reply with ONLY valid JSON." },
            { role: "user", content: prompt },
        ], { jsonMode: true });
        const data = result.data;
        log.info({ steps: data.steps?.length, complexity: data.estimatedComplexity }, "Plan complete");
        return data;
    }
    catch (err) {
        log.warn({ error: err.message }, "LLM planning failed — generating minimal plan from idea");
        const relevantFiles = keyFiles.filter(f => f.endsWith("index.html") || f.endsWith(".tsx") || f.endsWith(".css"));
        return {
            title: selectedIdea.title,
            approach: selectedIdea.description,
            steps: [{ step: 1, description: selectedIdea.description, files: relevantFiles.slice(0, 3) }],
            filesToCreate: [],
            filesToModify: relevantFiles.slice(0, 3),
            filesToDelete: [],
            acceptanceCriteria: ["Changes compile without errors"],
            regressionRisks: ["May affect existing functionality"],
            estimatedComplexity: "low",
        };
    }
}
//# sourceMappingURL=architect.js.map