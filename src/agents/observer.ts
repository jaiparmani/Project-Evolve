import { chatForTask } from "../llm/router.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { resolve, extname } from "path";
import { execSync } from "child_process";

const log = childLogger("observer");

interface Observation {
  category: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  details: string;
  filePath?: string;
  lineRange?: string;
  confidence: number;
  verified: boolean;
}

interface QualityDimensions {
  [key: string]: number | null | undefined;
  functionality: number | null;
  correctness: number | null;
  accessibility: number | null;
  performance: number | null;
  security: number | null;
  testCoverage: number | null;
  reliability: number | null;
}

interface ObservationResult {
  observations: Observation[];
  appSummary: string;
  qualityScore: number;
  qualityDimensions: QualityDimensions;
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

function readFullFiles(dir: string, files: string[], maxFiles = 15): string {
  const codeFiles = files.filter((f) => {
    const ext = extname(f);
    return [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json"].includes(ext);
  });
  const sampled = codeFiles.slice(0, maxFiles);
  const parts: string[] = [];
  for (const f of sampled) {
    try {
      const fullPath = resolve(dir, f);
      const st = statSync(fullPath);
      if (st.size > 50_000) continue;
      const content = readFileSync(fullPath, "utf-8");
      parts.push(`--- ${f} (${content.split("\n").length} lines) ---\n${content}`);
    } catch {}
  }
  return parts.join("\n\n");
}

function gatherVerifiableFacts(appDir: string): string {
  const facts: string[] = [];

  const pkgPath = resolve(appDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      facts.push(`package.json exists: name=${pkg.name || "unnamed"}`);
      facts.push(`scripts: ${Object.keys(pkg.scripts || {}).join(", ") || "none"}`);
      facts.push(`dependencies: ${Object.keys(pkg.dependencies || {}).join(", ") || "none"}`);
      facts.push(`devDependencies: ${Object.keys(pkg.devDependencies || {}).join(", ") || "none"}`);
      if (pkg.scripts?.test) facts.push(`test script: "${pkg.scripts.test}"`);
      else facts.push("no test script defined");
    } catch {}
  } else {
    facts.push("no package.json found");
  }

  const tsConfigPath = resolve(appDir, "tsconfig.json");
  facts.push(existsSync(tsConfigPath) ? "tsconfig.json exists" : "no tsconfig.json");

  const lockPath = resolve(appDir, "package-lock.json");
  if (existsSync(lockPath)) {
    facts.push("package-lock.json exists");
  }

  try {
    const tsResult = execSync("npx tsc --noEmit 2>&1 || true", {
      cwd: appDir,
      timeout: 30000,
      encoding: "utf-8",
    });
    const tsErrors = tsResult.split("\n").filter((l) => l.includes("error TS"));
    facts.push(`TypeScript check: ${tsErrors.length} errors`);
    if (tsErrors.length > 0) {
      facts.push(`First 5 TS errors:\n${tsErrors.slice(0, 5).join("\n")}`);
    }
  } catch {
    facts.push("TypeScript check: could not run");
  }

  return facts.join("\n");
}

export async function observe(
  projectId: string,
  cycleId: string,
  appDir: string
): Promise<ObservationResult> {
  log.info({ projectId, cycleId }, "Starting observation");

  const scan = scanDirectory(appDir);
  const codeContent = readFullFiles(appDir, scan.files);
  const verifiedFacts = gatherVerifiableFacts(appDir);

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

STRICT RULES:
1. Every finding MUST include the exact file path where the issue exists.
2. Include a "confidence" score (0.0 to 1.0) — how certain you are this is a real issue.
3. Set "verified" to true ONLY if you can point to specific code proving the issue. Set false for hypotheses.
4. Do NOT report a vulnerability based solely on a dependency name — you must find the vulnerable usage pattern in code.
5. Do NOT report accessibility issues unless you identify specific missing ARIA attributes or semantic HTML violations with file paths.
6. Distinguish between actual defects (bugs, errors) and improvement opportunities (refactors, features).
7. Check the VERIFIED FACTS below — these are ground truth. Do not contradict them.

APPLICATION STATE:
- Files: ${scan.files.length}
- Total lines: ${scan.totalLines}
- File types: ${JSON.stringify(scan.extensions)}
- File list: ${scan.files.join(", ")}

VERIFIED FACTS (ground truth from automated checks):
${verifiedFacts}

FULL SOURCE CODE:
${codeContent.slice(0, 8000)}

RECENT EVOLUTION HISTORY:
${historyContext || "No previous cycles"}

MEMORIES:
${memoryContext || "No memories yet"}

Return JSON:
{
  "observations": [
    {
      "category": "ui|ux|feature|architecture|performance|security|testing|accessibility|design",
      "description": "What you observed — must reference specific code",
      "severity": "low|medium|high|critical",
      "details": "Exact evidence: file path, line content, what is wrong",
      "filePath": "path/to/file.ts",
      "lineRange": "10-15",
      "confidence": 0.0-1.0,
      "verified": true|false
    }
  ],
  "appSummary": "Brief summary of the application's current state",
  "qualityScore": 0-100,
  "qualityDimensions": {
    "functionality": null or 0-100,
    "correctness": null or 0-100,
    "accessibility": null or 0-100,
    "performance": null or 0-100,
    "security": null or 0-100,
    "testCoverage": null or 0-100,
    "reliability": null or 0-100
  }
}

Set a dimension to null if you cannot measure it. Do not invent scores — only score what you can verify from the code.
Focus on meaningful, evidence-backed improvements. Prefer fewer high-confidence findings over many speculative ones.`;

  const result = await chatForTask("observe", [
    { role: "system", content: "You are a senior software engineer performing an evidence-based application review. Every finding must cite specific code. Reply with ONLY valid JSON." },
    { role: "user", content: prompt },
  ], { jsonMode: true });

  const raw = (result as { data: Record<string, unknown> }).data;

  const defaultDimensions: QualityDimensions = {
    functionality: null,
    correctness: null,
    accessibility: null,
    performance: null,
    security: null,
    testCoverage: null,
    reliability: null,
  };

  const data: ObservationResult = {
    observations: Array.isArray(raw.observations) ? raw.observations.map((o: Record<string, unknown>) => ({
      category: String(o.category || "architecture"),
      description: String(o.description || ""),
      severity: (["low", "medium", "high", "critical"].includes(String(o.severity)) ? String(o.severity) : "medium") as Observation["severity"],
      details: String(o.details || ""),
      filePath: o.filePath ? String(o.filePath) : undefined,
      lineRange: o.lineRange ? String(o.lineRange) : undefined,
      confidence: typeof o.confidence === "number" ? Math.min(1, Math.max(0, o.confidence)) : 0.5,
      verified: typeof o.verified === "boolean" ? o.verified : false,
    })) : [],
    appSummary: String(raw.appSummary || ""),
    qualityScore: typeof raw.qualityScore === "number" ? raw.qualityScore : 0,
    qualityDimensions: raw.qualityDimensions
      ? { ...defaultDimensions, ...(raw.qualityDimensions as Partial<QualityDimensions>) }
      : defaultDimensions,
  };

  const now = new Date().toISOString();

  for (const obs of data.observations) {
    await db.insert(schema.observations).values({
      id: nanoid(),
      cycleId,
      category: obs.category,
      description: obs.description,
      severity: obs.severity,
      details: JSON.stringify({
        evidence: obs.details,
        filePath: obs.filePath,
        lineRange: obs.lineRange,
        confidence: obs.confidence,
        verified: obs.verified,
      }),
      createdAt: now,
    });
  }

  log.info(
    {
      observations: data.observations.length,
      verified: data.observations.filter((o) => o.verified).length,
      quality: data.qualityScore,
    },
    "Observation complete"
  );

  return data;
}
