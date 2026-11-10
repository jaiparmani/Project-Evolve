import { chatForTask } from "../llm/router.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";
import { getEvolutionMode } from "../worker/state.js";

const log = childLogger("strategist");

interface Observation {
  category: string;
  description: string;
  severity: string;
  details: string;
  filePath?: string;
  confidence?: number;
  verified?: boolean;
}

interface Idea {
  title: string;
  description: string;
  category: string;
  impact: number;
  confidence: number;
  effort: number;
  strategicValue: number;
  reason: string;
  addressesObservation?: string;
}

interface DismissedFinding {
  observation: string;
  reason: string;
}

interface StrategyResult {
  ideas: Idea[];
  selectedIdea: Idea | null;
  selectionReason: string;
  dismissedFindings: DismissedFinding[];
  flaggedForReview: boolean;
  noActionJustification?: string;
}

export async function strategize(
  projectId: string,
  cycleId: string,
  observations: {
    observations: Observation[];
    appSummary: string;
    qualityScore: number;
    qualityDimensions?: Record<string, unknown>;
    roadmap?: {
      currentStageId: string;
      currentStageName: string;
      currentStageGoals: string[];
      stageProgress: Array<{ id: string; name: string; percentComplete: number; isComplete: boolean }>;
      overallProgress: number;
      failingGates: string[];
    };
  }
): Promise<StrategyResult> {
  log.info({ projectId, cycleId }, "Starting strategy");

  const previousIdeas = await db
    .select()
    .from(schema.ideas)
    .where(eq(schema.ideas.projectId, projectId))
    .orderBy(desc(schema.ideas.createdAt))
    .limit(20);

  const recentlyAttempted = previousIdeas
    .filter((i) => i.status === "implemented" || i.status === "rejected")
    .map((i) => `${i.title} (${i.status})`)
    .join(", ");

  const highSeverityCount = observations.observations.filter(
    (o) => o.severity === "high" || o.severity === "critical"
  ).length;
  const verifiedHighCount = observations.observations.filter(
    (o) => (o.severity === "high" || o.severity === "critical") && o.verified
  ).length;

  const roadmap = observations.roadmap;
  const nextGate = roadmap?.failingGates?.[0] || null;
  const mode = getEvolutionMode();
  log.info({ mode }, "Evolution mode");

  let roadmapSection = "";
  if (mode === "features") {
    roadmapSection = `
EVOLUTION MODE: FEATURES
You are in FEATURES mode. Ignore foundation gates and roadmap stages.
Focus ONLY on adding visible, user-facing features to the application:
- Add interactive UI elements (buttons, forms, dynamic content)
- Add new pages or views
- Add API endpoints that do something useful
- Add animations, transitions, visual improvements
- Add a useful feature (todo list, dashboard, calculator, weather, clock, etc.)

The goal is to make the app MORE INTERESTING and FUNCTIONAL for users.
Pick the most impactful, visible feature you can add in one cycle.
`;
  } else if (mode === "quality") {
    roadmapSection = `
EVOLUTION MODE: QUALITY
Focus on code quality, testing, security, and accessibility.
`;
  } else if (mode === "polish") {
    roadmapSection = `
EVOLUTION MODE: POLISH
Focus on visual design, UX, responsive layout, and documentation.
`;
  } else if (roadmap) {
    roadmapSection = `
EVOLUTION ROADMAP:
Current Stage: ${roadmap.currentStageName} (overall progress: ${roadmap.overallProgress}%)

THE MOST IMPORTANT THING RIGHT NOW:
Your #1 priority is to pass the NEXT failing gate. Pick the FIRST one and make it pass:
${roadmap.failingGates.length > 0 ? roadmap.failingGates.map((g: string, i: number) => `  ${i === 0 ? ">>> " : "    "}${i + 1}. ${g}`).join("\n") : "  All gates pass!"}

Stage Goals:
${roadmap.currentStageGoals.map((g: string) => `  - ${g}`).join("\n")}

CRITICAL RULE: Your selected idea MUST target the first failing gate listed above. Do NOT skip to later gates or other stages. One gate at a time.
`;
  }

  const prompt = `You are a product strategist for a self-improving application.

APPLICATION SUMMARY: ${observations.appSummary}
QUALITY SCORE: ${observations.qualityScore}/100
QUALITY DIMENSIONS: ${JSON.stringify(observations.qualityDimensions || {})}
${roadmapSection}
OBSERVATIONS (${observations.observations.length} total, ${highSeverityCount} high/critical, ${verifiedHighCount} verified high/critical):
${observations.observations.map((o) => {
  const prefix = o.verified ? "[VERIFIED]" : "[HYPOTHESIS]";
  const conf = o.confidence !== undefined ? ` (confidence: ${o.confidence})` : "";
  const file = o.filePath ? ` in ${o.filePath}` : "";
  return `- ${prefix} [${o.severity}] ${o.category}: ${o.description}${file}${conf}`;
}).join("\n")}

RECENTLY ATTEMPTED (do not repeat):
${recentlyAttempted || "None"}

RULES:
1. Generate up to 5 candidate improvements. Each must reference a specific observation it addresses.
2. Choose the single most valuable one based on: Priority = (Impact × Confidence × Strategic Value) / Effort
3. VERIFIED high-severity issues MUST be addressed — you cannot silently skip them.
4. For EVERY high/critical observation you do NOT address, provide an explicit reason in "dismissedFindings".
5. If you genuinely believe no change is warranted, set selectedIdea to null and provide detailed evidence in "noActionJustification".
6. Prefer improvements backed by verified observations over hypothetical ones.

Return JSON:
{
  "ideas": [
    {
      "title": "Short title",
      "description": "What to do and why, with specific file paths",
      "category": "ui|feature|architecture|performance|security|testing|ux|design",
      "impact": 1-10,
      "confidence": 1-10,
      "effort": 1-10,
      "strategicValue": 1-10,
      "reason": "Why this matters — cite the observation",
      "addressesObservation": "Which observation this fixes",
      "advancesStageGoal": "Which roadmap stage goal this advances (copy exact text)"
    }
  ],
  "selectedIdea": { same shape as above } or null,
  "selectionReason": "Why this was chosen over others",
  "dismissedFindings": [
    { "observation": "The high-severity finding", "reason": "Why it was not addressed this cycle" }
  ],
  "flaggedForReview": true if high-severity issues exist but no action taken,
  "noActionJustification": "Only if selectedIdea is null — detailed evidence that no change improves the app"
}`;

  let raw: Record<string, unknown> = {};
  try {
    const result = await chatForTask("strategize", [
      { role: "system", content: "You are a thoughtful product strategist. Every decision must be justified. Reply with ONLY valid JSON." },
      { role: "user", content: prompt },
    ], { jsonMode: true });
    raw = (result as { data: Record<string, unknown> }).data;
  } catch (llmErr) {
    log.warn({ error: (llmErr as Error).message }, "LLM call failed — using mode-aware deterministic strategy");
    const { getEvolutionMode } = await import("../worker/state.js");
    const mode = getEvolutionMode();
    const modeTitle = mode === "features" ? "Add new user-facing feature"
      : mode === "quality" ? "Improve code quality and accessibility"
      : mode === "polish" ? "Polish visual design and UX"
      : "Improve application foundation";
    const fallbackIdea: Idea = {
      title: modeTitle,
      description: modeTitle,
      category: mode,
      impact: 7,
      confidence: 8,
      effort: 3,
      strategicValue: 7,
      reason: `Deterministic fallback — LLM unavailable, mode: ${mode}`,
    };
    raw = {
      ideas: [fallbackIdea],
      selectedIdea: fallbackIdea,
      selectionReason: `LLM unavailable — deterministic fallback for ${mode} mode`,
      dismissedFindings: [],
      flaggedForReview: false,
    };
  }

  const data: StrategyResult = {
    ideas: Array.isArray(raw.ideas) ? raw.ideas as Idea[] : [],
    selectedIdea: raw.selectedIdea as Idea | null,
    selectionReason: String(raw.selectionReason || ""),
    dismissedFindings: Array.isArray(raw.dismissedFindings) ? raw.dismissedFindings as DismissedFinding[] : [],
    flaggedForReview: false,
    noActionJustification: raw.noActionJustification ? String(raw.noActionJustification) : undefined,
  };

  if (!data.selectedIdea && data.ideas.length > 0) {
    const best = data.ideas.reduce((a, b) => {
      const scoreA = (a.impact * a.confidence * a.strategicValue) / Math.max(a.effort, 1);
      const scoreB = (b.impact * b.confidence * b.strategicValue) / Math.max(b.effort, 1);
      return scoreB > scoreA ? b : a;
    });
    data.selectedIdea = best;
    data.selectionReason = `Auto-selected highest-scored idea (LLM returned no selection)`;
    log.warn({ selected: best.title }, "LLM returned no selectedIdea — auto-selecting best idea");
  }

  // If no idea selected in features mode, pick a concrete feature
  if (!data.selectedIdea && mode === "features") {
    const featureIdeas: Idea[] = [
      {
        title: "Add interactive status dashboard with live clock",
        description: "Add a live clock, server uptime display, and a button to check server health. Add JavaScript interactivity with fetch() calls to the /health endpoint.",
        category: "feature",
        impact: 9, confidence: 10, effort: 3, strategicValue: 9,
        reason: "Adds visible interactivity — the app does something users can see",
      },
      {
        title: "Add a visitor counter and greeting",
        description: "Add a visitor counter that increments on each page load (using an in-memory counter on the server with a new GET /api/visitors endpoint). Show a greeting based on time of day.",
        category: "feature",
        impact: 8, confidence: 10, effort: 3, strategicValue: 8,
        reason: "Adds a data layer and dynamic content",
      },
      {
        title: "Add dark/light theme toggle with smooth transitions",
        description: "Add a theme toggle button that switches between dark and light mode with CSS transitions. Save preference in localStorage.",
        category: "ui",
        impact: 7, confidence: 10, effort: 2, strategicValue: 7,
        reason: "Adds interactivity and user preference persistence",
      },
      {
        title: "Add navigation with multiple pages",
        description: "Add a navigation bar with Home, About, and Status pages. Use client-side routing or separate HTML pages served by the Express server.",
        category: "feature",
        impact: 8, confidence: 9, effort: 4, strategicValue: 8,
        reason: "Transforms from single-page to multi-page app",
      },
    ];
    // Pick one that hasn't been attempted
    const attempted = new Set(
      (await db.select().from(schema.ideas).where(eq(schema.ideas.projectId, projectId)).orderBy(desc(schema.ideas.createdAt)).limit(20))
        .filter(i => i.status === "implemented" || i.status === "rejected")
        .map(i => i.title)
    );
    const fresh = featureIdeas.find(i => !attempted.has(i.title)) || featureIdeas[0];
    data.ideas.push(fresh);
    data.selectedIdea = fresh;
    data.selectionReason = `Features mode: auto-selected "${fresh.title}"`;
    log.info({ selected: fresh.title }, "Features mode — auto-selecting feature idea");
  }

  // If no idea selected, target the first failing gate directly
  if (!data.selectedIdea && nextGate) {
    const gateIdeas: Record<string, Idea> = {
      "tsconfig.json exists": {
        title: "Add tsconfig.json for TypeScript support",
        description: "Create a tsconfig.json file in the app directory with a basic configuration for a Node.js web app. This is the first step toward type safety.",
        category: "architecture",
        impact: 8, confidence: 10, effort: 2, strategicValue: 9,
        reason: "Required to pass the Foundation stage tsconfig gate",
      },
      "Test script exists": {
        title: "Add a test script to package.json",
        description: "Add a simple test framework (vitest or jest) and create at least one basic test that verifies the server responds to requests. Update package.json scripts.test.",
        category: "testing",
        impact: 8, confidence: 9, effort: 3, strategicValue: 9,
        reason: "Required to pass the Foundation stage test gate",
      },
      "Server has error handling": {
        title: "Add error handling to the server",
        description: "Add try/catch blocks around route handlers in server.js and add process.on('uncaughtException') and process.on('unhandledRejection') handlers.",
        category: "architecture",
        impact: 8, confidence: 10, effort: 2, strategicValue: 9,
        reason: "Required to pass the Foundation stage error handling gate",
      },
      "TypeScript compiles without errors": {
        title: "Fix TypeScript compilation errors",
        description: "Fix all TypeScript errors reported by tsc --noEmit so the project compiles cleanly.",
        category: "architecture",
        impact: 8, confidence: 9, effort: 4, strategicValue: 9,
        reason: "Required to pass the Foundation stage TypeScript compilation gate",
      },
    };

    // Match the gate description to a predefined idea
    const matchedKey = Object.keys(gateIdeas).find(k => nextGate.includes(k));
    if (matchedKey) {
      const fallbackIdea = gateIdeas[matchedKey];
      data.ideas.push(fallbackIdea);
      data.selectedIdea = fallbackIdea;
      data.selectionReason = `Auto-targeting first failing gate: ${nextGate}`;
      log.info({ selected: fallbackIdea.title, gate: nextGate }, "Auto-targeting failing gate");
    }
  }

  if (!data.selectedIdea && highSeverityCount > 0) {
    const highObs = observations.observations.find((o) => o.severity === "high" || o.severity === "critical");
    if (highObs) {
      const fallbackIdea: Idea = {
        title: `Fix: ${highObs.description.slice(0, 60)}`,
        description: highObs.details || highObs.description,
        category: highObs.category as Idea["category"],
        impact: 8,
        confidence: highObs.confidence ?? 7,
        effort: 5,
        strategicValue: 8,
        reason: `Auto-selected: highest severity finding`,
        addressesObservation: highObs.description,
      };
      data.ideas.push(fallbackIdea);
      data.selectedIdea = fallbackIdea;
      data.selectionReason = "Auto-selected: LLM returned no ideas, picked highest severity observation";
      log.warn({ selected: fallbackIdea.title }, "No ideas from LLM — auto-creating from highest severity observation");
    }
  }

  if (!data.selectedIdea && verifiedHighCount > 0) {
    data.flaggedForReview = true;
    log.warn(
      { verifiedHighCount, dismissed: data.dismissedFindings.length },
      "FLAGGED: High-severity verified issues exist but no action was selected"
    );
  }

  if (raw.flaggedForReview === true) {
    data.flaggedForReview = true;
  }

  const now = new Date().toISOString();

  for (const idea of data.ideas) {
    const score = (idea.impact * idea.confidence * idea.strategicValue) / Math.max(idea.effort, 1);
    await db.insert(schema.ideas).values({
      id: nanoid(),
      projectId,
      cycleId,
      title: idea.title,
      description: idea.description,
      category: idea.category,
      impact: idea.impact,
      confidence: idea.confidence,
      effort: idea.effort,
      strategicValue: idea.strategicValue,
      priorityScore: score,
      status: data.selectedIdea && idea.title === data.selectedIdea.title ? "selected" : "proposed",
      reason: idea.reason,
      createdAt: now,
    });
  }

  log.info(
    {
      selected: data.selectedIdea?.title || "none",
      ideas: data.ideas.length,
      flagged: data.flaggedForReview,
      dismissed: data.dismissedFindings.length,
    },
    "Strategy complete"
  );

  return data;
}
