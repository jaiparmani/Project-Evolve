import { chatForTask } from "../llm/router.js";
import { childLogger } from "../core/logger.js";
import { readdirSync, readFileSync, existsSync } from "fs";
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

/**
 * An outline of each key file rather than its full text: the planner needs to
 * know what exists and where, not every line. Keeping the prompt small is what
 * lets free models answer before the timeout.
 */
function readRelevantFiles(dir: string, fileList: string[]): string {
  const parts: string[] = [];
  for (const f of fileList.slice(0, 12)) {
    try {
      const content = readFileSync(resolve(dir, f), "utf-8");
      if (content.length <= 2500) { parts.push(`--- ${f} (${content.length} chars) ---\n${content}`); continue; }
      const outline = content.split("\n")
        .filter((l) => /<(section|div|nav|header|main|footer|h[1-3])[^>]*\bid=|<h[1-3]|function\s+\w+|class\s+\w+|app\.(get|post|use)\(|export\s|^\s*\.[\w-]+\s*\{|<script|<link|<style/.test(l))
        .map((l) => l.trim().slice(0, 140))
        .slice(0, 80);
      parts.push(`--- ${f} (${content.length} chars; outline) ---\n${outline.join("\n")}`);
    } catch {}
  }
  return parts.join("\n\n");
}

const PATH_RE = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:html|css|js|mjs|ts|json|md|webmanifest|svg))(?=[\s`'"),.:;]|$)/g;

/**
 * When the planner model fails, turn the idea's own brief into a plan instead of
 * defaulting to "edit index.html": each spec line becomes a step, and file paths
 * mentioned in the brief become files to create or modify.
 */
export function planFromBrief(
  appDir: string,
  idea: { title: string; description: string },
  keyFiles: string[],
  reason: string
): ImplementationPlan & { planSource: string; planError?: string } {
  const text = idea.description || idea.title;
  const specLines = text.split("\n").map((l) => l.trim()).filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l)).map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, ""));
  const doneIdx = text.indexOf("Done when:");
  const stepLines = specLines.filter((l) => doneIdx < 0 || text.indexOf(l) < doneIdx);
  const acceptance = doneIdx >= 0 ? specLines.filter((l) => text.indexOf(l) > doneIdx) : [];
  const paths = [...new Set([...text.matchAll(PATH_RE)].map((m) => m[1].replace(/^\.?\//, "").replace(/^evolving-app\//, "")))]
    .filter((p) => !p.startsWith("node_modules"));
  const toModify = paths.filter((p) => existsSync(resolve(appDir, p)));
  const toCreate = paths.filter((p) => !existsSync(resolve(appDir, p)));
  if (!toModify.length) toModify.push(...keyFiles.filter((f) => f === "index.html"));
  const steps = (stepLines.length ? stepLines : [text]).slice(0, 10).map((d, i) => ({
    step: i + 1,
    description: d,
    files: paths.filter((p) => d.includes(p)).length ? paths.filter((p) => d.includes(p)) : (i === 0 ? toModify.slice(0, 1) : []),
  }));
  return {
    title: idea.title,
    approach: text.split("\n")[0],
    steps,
    filesToCreate: toCreate,
    filesToModify: toModify,
    filesToDelete: [],
    acceptanceCriteria: acceptance.length ? acceptance : [`${idea.title} is implemented and visible in the app`],
    regressionRisks: ["Existing features in index.html must keep working"],
    estimatedComplexity: toCreate.length > 2 ? "high" : "medium",
    planSource: "brief",
    planError: reason,
  };
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

KEY FILES (small files in full, large ones as an outline):
${fileContents.slice(0, 16000)}

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

Be specific about file paths and changes. Think BIG: plan a substantial upgrade that a user would
immediately notice — new pages, multi-file features, real interactivity, or a full visual redesign.
Spread the work across as many files as it needs (new files are welcome); 3-8 steps is typical.
If the description names files, pages or folders, include every one of them in filesToCreate or filesToModify.
The app is served as static files: any new page or script must be linked from index.html (or the shared nav) so users can reach it.`;

  try {
    const result = await chatForTask("plan", [
      { role: "system", content: "You are a senior software architect. Reply with ONLY valid JSON." },
      { role: "user", content: prompt },
    ], { jsonMode: true, maxTokens: 6144, timeoutMs: 150_000 });

    const data = (result as unknown as { data: ImplementationPlan }).data;
    if (!Array.isArray(data?.steps) || !data.steps.length) throw new Error("Planner returned no steps");
    log.info({ steps: data.steps?.length, complexity: data.estimatedComplexity }, "Plan complete");
    return { ...data, planSource: "llm" } as ImplementationPlan;
  } catch (err) {
    const reason = (err as Error).message;
    log.warn({ error: reason }, "LLM planning failed — building the plan from the idea's brief");
    return planFromBrief(appDir, selectedIdea, keyFiles, reason);
  }
}
