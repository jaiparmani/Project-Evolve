import { chatForTask } from "../llm/router.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";

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

  const prompt = `You are a product strategist for a self-improving application.

APPLICATION SUMMARY: ${observations.appSummary}
QUALITY SCORE: ${observations.qualityScore}/100
QUALITY DIMENSIONS: ${JSON.stringify(observations.qualityDimensions || {})}

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
      "addressesObservation": "Which observation this fixes"
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

  const result = await chatForTask("strategize", [
    { role: "system", content: "You are a thoughtful product strategist. Every decision must be justified. Reply with ONLY valid JSON." },
    { role: "user", content: prompt },
  ], { jsonMode: true });

  const raw = (result as { data: Record<string, unknown> }).data;

  const data: StrategyResult = {
    ideas: Array.isArray(raw.ideas) ? raw.ideas as Idea[] : [],
    selectedIdea: raw.selectedIdea as Idea | null,
    selectionReason: String(raw.selectionReason || ""),
    dismissedFindings: Array.isArray(raw.dismissedFindings) ? raw.dismissedFindings as DismissedFinding[] : [],
    flaggedForReview: false,
    noActionJustification: raw.noActionJustification ? String(raw.noActionJustification) : undefined,
  };

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
