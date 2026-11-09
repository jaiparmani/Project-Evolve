import { chatForTask } from "../llm/router.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, extname } from "path";

const log = childLogger("observer");

interface Observation {
  category: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  details: string;
}

interface ObservationResult {
  observations: Observation[];
  appSummary: string;
  qualityScore: number;
}

function scanDirectory(
  dir: string,
  prefix = ""
): { files: string[]; totalLines: number; extensions: Record<string, number> } {
  const files: string[] = [];
  const extensions: Record<string, number> = {};
  let totalLines = 0;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist")
        continue;
      const path = resolve(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        const sub = scanDirectory(path, rel);
        files.push(...sub.files);
        totalLines += sub.totalLines;
        for (const [ext, count] of Object.entries(sub.extensions)) {
          extensions[ext] = (extensions[ext] || 0) + count;
        }
      } else {
        files.push(rel);
        const ext = extname(entry.name);
        extensions[ext] = (extensions[ext] || 0) + 1;
        try {
          const content = readFileSync(path, "utf-8");
          totalLines += content.split("\n").length;
        } catch {}
      }
    }
  } catch {}

  return { files, totalLines, extensions };
}

function readFilesSample(dir: string, files: string[], maxFiles = 10): string {
  const sampled = files.slice(0, maxFiles);
  const parts: string[] = [];
  for (const f of sampled) {
    try {
      const content = readFileSync(resolve(dir, f), "utf-8");
      const lines = content.split("\n");
      const preview = lines.slice(0, 50).join("\n");
      parts.push(`--- ${f} (${lines.length} lines) ---\n${preview}`);
    } catch {}
  }
  return parts.join("\n\n");
}

export async function observe(
  projectId: string,
  cycleId: string,
  appDir: string
): Promise<ObservationResult> {
  log.info({ projectId, cycleId }, "Starting observation");

  const scan = scanDirectory(appDir);
  const codeSample = readFilesSample(appDir, scan.files);

  const recentCycles = await db
    .select()
    .from(schema.evolutionCycles)
    .where(eq(schema.evolutionCycles.projectId, projectId))
    .orderBy(desc(schema.evolutionCycles.createdAt))
    .limit(5);

  const recentMemories = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId))
    .orderBy(desc(schema.memories.importance))
    .limit(10);

  const historyContext = recentCycles
    .map(
      (c) =>
        `Cycle ${c.cycleNumber}: ${c.status} - ${c.selectedImprovement || "none"} (${c.lessonsLearned || "no lessons"})`
    )
    .join("\n");

  const memoryContext = recentMemories.map((m) => `[${m.category}] ${m.content}`).join("\n");

  const prompt = `You are an application observer agent. Analyze this application and identify areas for improvement.

APPLICATION STATE:
- Files: ${scan.files.length}
- Total lines: ${scan.totalLines}
- File types: ${JSON.stringify(scan.extensions)}
- File list: ${scan.files.join(", ")}

CODE SAMPLE:
${codeSample.slice(0, 3000)}

RECENT EVOLUTION HISTORY:
${historyContext || "No previous cycles"}

MEMORIES:
${memoryContext || "No memories yet"}

Produce a JSON object with:
{
  "observations": [
    {
      "category": "ui|ux|feature|architecture|performance|security|testing|accessibility|design",
      "description": "What you observed",
      "severity": "low|medium|high|critical",
      "details": "Specific details"
    }
  ],
  "appSummary": "Brief summary of the application's current state",
  "qualityScore": 0-100
}

Be specific and actionable. Focus on meaningful improvements, not cosmetic ones.`;

  const result = await chatForTask("observe", [
    { role: "system", content: "You are a senior software engineer performing an application review. Reply with ONLY valid JSON." },
    { role: "user", content: prompt },
  ], { jsonMode: true });

  const data = (result as { data: ObservationResult }).data;
  const now = new Date().toISOString();

  for (const obs of data.observations || []) {
    await db.insert(schema.observations).values({
      id: nanoid(),
      cycleId,
      category: obs.category,
      description: obs.description,
      severity: obs.severity,
      details: obs.details,
      createdAt: now,
    });
  }

  log.info(
    { observations: data.observations?.length, quality: data.qualityScore },
    "Observation complete"
  );

  return data;
}
