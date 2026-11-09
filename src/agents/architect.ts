import { chatForTask } from "../llm/router.js";
import { childLogger } from "../core/logger.js";
import { readdirSync, readFileSync } from "fs";
import { resolve, extname } from "path";

const log = childLogger("architect");

interface ImplementationPlan {
  title: string;
  approach: string;
  steps: Array<{ step: number; description: string; files: string[] }>;
  filesToCreate: string[];
  filesToModify: string[];
  filesToDelete: string[];
  acceptanceCriteria: string[];
  regressionRisks: string[];
  estimatedComplexity: "low" | "medium" | "high";
}

function getProjectStructure(dir: string, depth = 3, prefix = ""): string[] {
  const result: string[] = [];
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
  } catch {}
  return result;
}

function readRelevantFiles(dir: string, fileList: string[]): string {
  const parts: string[] = [];
  for (const f of fileList.slice(0, 8)) {
    try {
      const full = resolve(dir, f);
      const content = readFileSync(full, "utf-8");
      parts.push(`--- ${f} ---\n${content.slice(0, 2000)}`);
    } catch {}
  }
  return parts.join("\n\n");
}

export async function plan(
  appDir: string,
  selectedIdea: { title: string; description: string; category: string },
  observations: { appSummary: string }
): Promise<ImplementationPlan> {
  log.info({ idea: selectedIdea.title }, "Planning implementation");

  const structure = getProjectStructure(appDir);
  const keyFiles = structure.filter(
    (f) =>
      f.endsWith("package.json") ||
      f.endsWith("tsconfig.json") ||
      f.endsWith(".tsx") ||
      f.endsWith(".ts") ||
      f.endsWith("index.html") ||
      f.endsWith(".css")
  );
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

  const result = await chatForTask("plan", [
    { role: "system", content: "You are a senior software architect. Reply with ONLY valid JSON." },
    { role: "user", content: prompt },
  ], { jsonMode: true });

  const data = (result as { data: ImplementationPlan }).data;
  log.info({ steps: data.steps?.length, complexity: data.estimatedComplexity }, "Plan complete");
  return data;
}
