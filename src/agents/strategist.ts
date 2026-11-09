import { chatForTask } from "../llm/router.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";

const log = childLogger("strategist");

interface Idea {
  title: string;
  description: string;
  category: string;
  impact: number;
  confidence: number;
  effort: number;
  strategicValue: number;
  reason: string;
}

interface StrategyResult {
  ideas: Idea[];
  selectedIdea: Idea;
  selectionReason: string;
}

export async function strategize(
  projectId: string,
  cycleId: string,
  observations: { observations: Array<{ category: string; description: string; severity: string; details: string }>; appSummary: string; qualityScore: number }
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

  const prompt = `You are a product strategist for a self-improving application.

APPLICATION SUMMARY: ${observations.appSummary}
QUALITY SCORE: ${observations.qualityScore}/100

OBSERVATIONS:
${observations.observations.map((o) => `- [${o.severity}] ${o.category}: ${o.description}`).join("\n")}

RECENTLY ATTEMPTED (do not repeat):
${recentlyAttempted || "None"}

Generate up to 5 candidate improvements. Choose the single most valuable one.

Priority = (Impact × Confidence × Strategic Value) / Effort

Return JSON:
{
  "ideas": [
    {
      "title": "Short title",
      "description": "What to do and why",
      "category": "ui|feature|architecture|performance|security|testing|ux|design",
      "impact": 1-10,
      "confidence": 1-10,
      "effort": 1-10,
      "strategicValue": 1-10,
      "reason": "Why this matters"
    }
  ],
  "selectedIdea": { same shape as above },
  "selectionReason": "Why this was chosen over others"
}

Prefer meaningful changes. Do not propose changes just for activity.
If doing nothing is better than all options, say so in selectionReason and pick the least harmful small improvement.`;

  const result = await chatForTask("strategize", [
    { role: "system", content: "You are a thoughtful product strategist. Reply with ONLY valid JSON." },
    { role: "user", content: prompt },
  ], { jsonMode: true });

  const data = (result as { data: StrategyResult }).data;
  const now = new Date().toISOString();

  for (const idea of data.ideas || []) {
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
      status: idea.title === data.selectedIdea?.title ? "selected" : "proposed",
      reason: idea.reason,
      createdAt: now,
    });
  }

  log.info({ selected: data.selectedIdea?.title, ideas: data.ideas?.length }, "Strategy complete");
  return data;
}
