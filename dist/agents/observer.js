import { chatForTask } from "../llm/router.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { resolve, extname } from "path";
import { execSync } from "child_process";
import { evaluateRoadmap } from "../core/roadmap.js";
const log = childLogger("observer");
function scanDirectory(dir, prefix = "") {
    const files = [];
    const extensions = {};
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
            }
            else {
                files.push(rel);
                const ext = extname(entry.name);
                extensions[ext] = (extensions[ext] || 0) + 1;
                try {
                    const content = readFileSync(path, "utf-8");
                    totalLines += content.split("\n").length;
                }
                catch { }
            }
        }
    }
    catch { }
    return { files, totalLines, extensions };
}
function readFullFiles(dir, files, maxFiles = 15) {
    const codeFiles = files.filter((f) => {
        const ext = extname(f);
        return [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json"].includes(ext);
    });
    const sampled = codeFiles.slice(0, maxFiles);
    const parts = [];
    for (const f of sampled) {
        try {
            const fullPath = resolve(dir, f);
            const st = statSync(fullPath);
            if (st.size > 50_000)
                continue;
            const content = readFileSync(fullPath, "utf-8");
            parts.push(`--- ${f} (${content.split("\n").length} lines) ---\n${content}`);
        }
        catch { }
    }
    return parts.join("\n\n");
}
function gatherVerifiableFacts(appDir) {
    const facts = [];
    const pkgPath = resolve(appDir, "package.json");
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            facts.push(`package.json exists: name=${pkg.name || "unnamed"}`);
            facts.push(`scripts: ${Object.keys(pkg.scripts || {}).join(", ") || "none"}`);
            facts.push(`dependencies: ${Object.keys(pkg.dependencies || {}).join(", ") || "none"}`);
            facts.push(`devDependencies: ${Object.keys(pkg.devDependencies || {}).join(", ") || "none"}`);
            if (pkg.scripts?.test)
                facts.push(`test script: "${pkg.scripts.test}"`);
            else
                facts.push("no test script defined");
        }
        catch { }
    }
    else {
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
    }
    catch {
        facts.push("TypeScript check: could not run");
    }
    return facts.join("\n");
}
export async function observe(projectId, cycleId, appDir) {
    log.info({ projectId, cycleId }, "Starting observation");
    const scan = scanDirectory(appDir);
    const codeContent = readFullFiles(appDir, scan.files);
    const verifiedFacts = gatherVerifiableFacts(appDir);
    const roadmapEval = evaluateRoadmap(appDir);
    const failingGates = roadmapEval.stageStatuses
        .flatMap((ss) => ss.gateResults.filter((g) => !g.passed).map((g) => `[${ss.stage.name}] ${g.gate.description}`));
    const roadmapContext = {
        currentStageId: roadmapEval.currentStage.id,
        currentStageName: roadmapEval.currentStage.name,
        currentStageGoals: roadmapEval.currentStage.goals,
        stageProgress: roadmapEval.stageStatuses.map((ss) => ({
            id: ss.stage.id,
            name: ss.stage.name,
            percentComplete: ss.percentComplete,
            isComplete: ss.isComplete,
        })),
        overallProgress: roadmapEval.overallProgress,
        failingGates,
    };
    log.info({ stage: roadmapContext.currentStageName, progress: roadmapContext.overallProgress, failingGates: failingGates.length }, "Roadmap evaluated");
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
        .map((c) => `Cycle ${c.cycleNumber}: ${c.status} - ${c.selectedImprovement || "none"} (${c.lessonsLearned || "no lessons"})`)
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

EVOLUTION ROADMAP:
Current Stage: ${roadmapContext.currentStageName} (${roadmapContext.overallProgress}% overall progress)
Stage Goals:
${roadmapContext.currentStageGoals.map((g) => `  - ${g}`).join("\n")}

Failing Gates (things that must be fixed to advance):
${failingGates.length > 0 ? failingGates.map((g) => `  - ${g}`).join("\n") : "  None — all gates pass for current stage"}

Stage Progress:
${roadmapContext.stageProgress.map((s) => `  ${s.name}: ${s.percentComplete}%${s.isComplete ? " ✓" : ""}`).join("\n")}

IMPORTANT: Focus your observations on issues that block the CURRENT STAGE goals. Observations aligned with the roadmap should have higher severity.

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
    let raw = {};
    try {
        const result = await chatForTask("observe", [
            { role: "system", content: "You are a senior software engineer performing an evidence-based application review. Every finding must cite specific code. Reply with ONLY valid JSON." },
            { role: "user", content: prompt },
        ], { jsonMode: true });
        raw = result.data;
    }
    catch (llmErr) {
        log.warn({ error: llmErr.message }, "LLM call failed — falling back to baseline observations");
    }
    const defaultDimensions = {
        functionality: null,
        correctness: null,
        accessibility: null,
        performance: null,
        security: null,
        testCoverage: null,
        reliability: null,
    };
    let parsedObservations = Array.isArray(raw.observations) ? raw.observations.map((o) => ({
        category: String(o.category || "architecture"),
        description: String(o.description || ""),
        severity: (["low", "medium", "high", "critical"].includes(String(o.severity)) ? String(o.severity) : "medium"),
        details: String(o.details || ""),
        filePath: o.filePath ? String(o.filePath) : undefined,
        lineRange: o.lineRange ? String(o.lineRange) : undefined,
        confidence: typeof o.confidence === "number" ? Math.min(1, Math.max(0, o.confidence)) : 0.5,
        verified: typeof o.verified === "boolean" ? o.verified : false,
    })) : [];
    if (parsedObservations.length === 0) {
        log.warn("LLM returned zero observations — generating baseline from automated checks");
        parsedObservations = generateBaselineObservations(appDir, verifiedFacts);
    }
    const data = {
        observations: parsedObservations,
        appSummary: String(raw.appSummary || `Application with ${scan.files.length} files, ${scan.totalLines} lines of code`),
        qualityScore: typeof raw.qualityScore === "number" && raw.qualityScore > 0 ? raw.qualityScore : calculateBaselineScore(appDir),
        qualityDimensions: raw.qualityDimensions
            ? { ...defaultDimensions, ...raw.qualityDimensions }
            : calculateBaselineDimensions(appDir),
        roadmap: roadmapContext,
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
    log.info({
        observations: data.observations.length,
        verified: data.observations.filter((o) => o.verified).length,
        quality: data.qualityScore,
    }, "Observation complete");
    return data;
}
function generateBaselineObservations(appDir, verifiedFacts) {
    const observations = [];
    const pkgPath = resolve(appDir, "package.json");
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            if (!pkg.scripts?.test || pkg.scripts.test.includes("no test specified")) {
                observations.push({
                    category: "testing",
                    description: "No test suite configured — package.json has no meaningful test script",
                    severity: "high",
                    details: `package.json scripts.test is "${pkg.scripts?.test || "missing"}"`,
                    filePath: "package.json",
                    confidence: 1.0,
                    verified: true,
                });
            }
            if (!pkg.scripts?.lint) {
                observations.push({
                    category: "architecture",
                    description: "No linting configured — no lint script in package.json",
                    severity: "medium",
                    details: "Missing lint script means code style is not enforced",
                    filePath: "package.json",
                    confidence: 1.0,
                    verified: true,
                });
            }
        }
        catch { }
    }
    if (!existsSync(resolve(appDir, "tsconfig.json"))) {
        const hasJsFiles = verifiedFacts.includes(".js");
        if (hasJsFiles) {
            observations.push({
                category: "architecture",
                description: "No TypeScript — application uses plain JavaScript without type checking",
                severity: "medium",
                details: "No tsconfig.json found. TypeScript would catch type errors at compile time.",
                filePath: "package.json",
                confidence: 1.0,
                verified: true,
            });
        }
    }
    if (verifiedFacts.includes("TypeScript check:") && verifiedFacts.includes("errors")) {
        const match = verifiedFacts.match(/TypeScript check: (\d+) errors/);
        if (match && parseInt(match[1]) > 0) {
            observations.push({
                category: "architecture",
                description: `TypeScript compilation has ${match[1]} errors`,
                severity: "high",
                details: `Verified by running tsc --noEmit: ${match[1]} type errors found`,
                filePath: "tsconfig.json",
                confidence: 1.0,
                verified: true,
            });
        }
    }
    const serverFiles = ["server.js", "server.ts", "src/server.ts", "src/index.ts", "index.js"];
    for (const sf of serverFiles) {
        const serverPath = resolve(appDir, sf);
        if (existsSync(serverPath)) {
            try {
                const content = readFileSync(serverPath, "utf-8");
                if (!content.includes("try") && !content.includes("catch") && !content.includes(".on('error')") && !content.includes(".on(\"error\")")) {
                    observations.push({
                        category: "reliability",
                        description: `No error handling in ${sf} — server has no try/catch or error event handlers`,
                        severity: "high",
                        details: `${sf} lacks error handling. Unhandled errors will crash the process.`,
                        filePath: sf,
                        confidence: 0.9,
                        verified: true,
                    });
                }
            }
            catch { }
            break;
        }
    }
    const htmlFiles = readdirSync(appDir).filter((f) => f.endsWith(".html"));
    for (const hf of htmlFiles) {
        try {
            const content = readFileSync(resolve(appDir, hf), "utf-8");
            if (!content.includes("aria-") && !content.includes("role=")) {
                observations.push({
                    category: "accessibility",
                    description: `${hf} has no ARIA attributes — screen readers may not navigate correctly`,
                    severity: "medium",
                    details: `No aria-label, aria-describedby, role, or other ARIA attributes found in ${hf}`,
                    filePath: hf,
                    confidence: 0.8,
                    verified: true,
                });
            }
        }
        catch { }
    }
    return observations;
}
function calculateBaselineScore(appDir) {
    let score = 30;
    const pkgPath = resolve(appDir, "package.json");
    if (existsSync(pkgPath)) {
        score += 10;
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            if (pkg.scripts?.start)
                score += 5;
            if (pkg.scripts?.test && !pkg.scripts.test.includes("no test specified"))
                score += 10;
            if (pkg.scripts?.build)
                score += 5;
            if (pkg.scripts?.lint)
                score += 5;
        }
        catch { }
    }
    if (existsSync(resolve(appDir, "tsconfig.json")))
        score += 10;
    if (existsSync(resolve(appDir, ".gitignore")))
        score += 5;
    return Math.min(100, score);
}
function calculateBaselineDimensions(appDir) {
    const dims = {
        functionality: null,
        correctness: null,
        accessibility: null,
        performance: null,
        security: null,
        testCoverage: 0,
        reliability: null,
    };
    const pkgPath = resolve(appDir, "package.json");
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            if (pkg.scripts?.test && !pkg.scripts.test.includes("no test specified")) {
                dims.testCoverage = 20;
            }
        }
        catch { }
    }
    if (existsSync(resolve(appDir, "tsconfig.json"))) {
        dims.correctness = 50;
    }
    return dims;
}
//# sourceMappingURL=observer.js.map