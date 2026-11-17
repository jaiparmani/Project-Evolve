/**
 * Idea queue: user-submitted and promoted system ideas that upcoming cycles
 * build in order, ahead of the strategist's own picks.
 *
 * Lifecycle:
 *   user idea   → evaluating → queued → building → shipped | failed
 *   system idea → proposed → (user promotes) queued → building → …
 *   any open idea → dismissed
 */
import { db, schema } from "../db/index.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { chatForTask } from "../llm/router.js";
import { childLogger } from "./logger.js";
import { getEvolutionMode } from "../worker/state.js";

const log = childLogger("idea-queue");

export type IdeaRow = typeof schema.ideas.$inferSelect;

export interface IdeaAnalysis {
  summary: string;
  spec: string[];
  acceptance: string[];
  risks: string[];
  verdict: "build" | "rework" | "reject";
  verdictReason: string;
  model?: string;
  fallback?: boolean;
}

const OPEN_STATUSES = ["evaluating", "queued", "building"];

function nowIso() { return new Date().toISOString(); }

async function projectId(): Promise<string> {
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects).limit(1);
  if (rows.length) return rows[0].id;
  const id = nanoid();
  const now = nowIso();
  await db.insert(schema.projects).values({
    id, name: "Evolving App", description: "An application that improves itself autonomously",
    appDir: process.env.APP_DIR || "./app", identity: "A modern web application that continuously evolves",
    createdAt: now, updatedAt: now,
  });
  return id;
}

async function nextRank(top = false): Promise<number> {
  const [row] = await db
    .select({ lo: sql<number>`min(${schema.ideas.queueRank})`, hi: sql<number>`max(${schema.ideas.queueRank})` })
    .from(schema.ideas)
    .where(inArray(schema.ideas.status, OPEN_STATUSES));
  if (top) return (row?.lo ?? 1) - 1;
  return (row?.hi ?? 0) + 1;
}

function score(i: { impact?: number | null; confidence?: number | null; strategicValue?: number | null }) {
  return (i.impact ?? 5) * (i.confidence ?? 5) * (i.strategicValue ?? 5);
}

export function parseAnalysis(raw: string | null | undefined): IdeaAnalysis | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as IdeaAnalysis; } catch { return null; }
}

/** Submit a user idea. It is queued right away and analysed in the background. */
export async function submitIdea(input: { title: string; description?: string; top?: boolean }): Promise<IdeaRow> {
  const id = nanoid();
  const now = nowIso();
  await db.insert(schema.ideas).values({
    id,
    projectId: await projectId(),
    cycleId: null,
    title: input.title.trim().slice(0, 200),
    description: (input.description || input.title).trim().slice(0, 4000),
    category: "feature",
    impact: 8, confidence: 7, effort: 5, strategicValue: 8,
    priorityScore: 448,
    status: "evaluating",
    source: "user",
    queueRank: await nextRank(input.top),
    reason: "Submitted from the control room",
    createdAt: now,
    updatedAt: now,
  });
  setImmediate(() => { analyseIdea(id).catch((e) => log.warn({ id, error: (e as Error).message }, "Idea analysis crashed")); });
  const [row] = await db.select().from(schema.ideas).where(eq(schema.ideas.id, id));
  return row;
}

/** Ask the planner model to think the idea through: refine it, score it, spec it. */
export async function analyseIdea(id: string): Promise<void> {
  const [idea] = await db.select().from(schema.ideas).where(eq(schema.ideas.id, id));
  if (!idea) return;
  await db.update(schema.ideas).set({ status: "evaluating", updatedAt: nowIso() }).where(eq(schema.ideas.id, id));

  const recentlyShipped = await db
    .select({ title: schema.evolutionCycles.selectedImprovement })
    .from(schema.evolutionCycles)
    .where(eq(schema.evolutionCycles.status, "completed"))
    .orderBy(desc(schema.evolutionCycles.cycleNumber))
    .limit(15);

  const prompt = `You are the product lead for a self-evolving single-page web app (vanilla HTML/CSS/JS served by a small Node server).
A human operator submitted this idea for the next evolution cycle:

TITLE: ${idea.title}
DETAILS: ${idea.description}

Recently shipped by the engine (avoid duplicating these):
${recentlyShipped.map((r) => `- ${r.title}`).join("\n") || "- (nothing yet)"}

Think it through and turn it into a buildable brief. Be ambitious but concrete: the builder can create or rewrite several files in one cycle.
Reply with ONLY a JSON object:
{
  "title": "Short imperative title (max 70 chars)",
  "summary": "1-2 sentences on what the user gets and why it matters",
  "spec": ["4-8 concrete implementation steps naming files/UI elements"],
  "acceptance": ["3-5 checks that prove it works"],
  "risks": ["0-3 risks or open questions"],
  "category": "feature|ui|ux|performance|accessibility|testing|architecture|design",
  "impact": 1-10, "confidence": 1-10, "effort": 1-10, "strategicValue": 1-10,
  "verdict": "build" | "rework" | "reject",
  "verdictReason": "one sentence"
}`;

  try {
    const res = (await chatForTask("plan", [{ role: "user", content: prompt }], { jsonMode: true, maxTokens: 2048, timeoutMs: 90_000 })) as {
      data: Record<string, any>; meta: { model: string };
    };
    const d = res.data || {};
    const num = (v: unknown, f: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : f; };
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 8) : []);
    const analysis: IdeaAnalysis = {
      summary: String(d.summary || idea.description).slice(0, 600),
      spec: list(d.spec),
      acceptance: list(d.acceptance),
      risks: list(d.risks),
      verdict: ["build", "rework", "reject"].includes(d.verdict) ? d.verdict : "build",
      verdictReason: String(d.verdictReason || "").slice(0, 300),
      model: res.meta?.model,
    };
    const scores = {
      impact: num(d.impact, 7), confidence: num(d.confidence, 7), effort: num(d.effort, 5), strategicValue: num(d.strategicValue, 7),
    };
    const title = typeof d.title === "string" && d.title.trim() ? d.title.trim().slice(0, 120) : idea.title;
    await db.update(schema.ideas).set({
      title,
      category: typeof d.category === "string" ? d.category : idea.category,
      ...scores,
      priorityScore: score(scores),
      analysis: JSON.stringify(analysis),
      status: "queued",
      updatedAt: nowIso(),
    }).where(and(eq(schema.ideas.id, id), eq(schema.ideas.status, "evaluating")));
    log.info({ id, title, verdict: analysis.verdict }, "Idea analysed and queued");
  } catch (e) {
    // Never lose the user's idea because the model is down: queue it as written.
    const analysis: IdeaAnalysis = {
      summary: idea.description,
      spec: [], acceptance: [], risks: [],
      verdict: "build",
      verdictReason: "Queued as written: the analysis model was unavailable.",
      fallback: true,
    };
    await db.update(schema.ideas).set({ analysis: JSON.stringify(analysis), status: "queued", updatedAt: nowIso() })
      .where(and(eq(schema.ideas.id, id), eq(schema.ideas.status, "evaluating")));
    log.warn({ id, error: (e as Error).message }, "Idea analysis failed — queued as written");
  }
}

/** Put any open idea (usually a system proposal) into the queue. */
export async function queueIdea(id: string, top = false) {
  await db.update(schema.ideas)
    .set({ status: "queued", queueRank: await nextRank(top), updatedAt: nowIso() })
    .where(eq(schema.ideas.id, id));
}

export async function dismissIdea(id: string) {
  await db.update(schema.ideas).set({ status: "dismissed", updatedAt: nowIso() })
    .where(and(eq(schema.ideas.id, id), sql`${schema.ideas.status} != 'building'`));
}

export async function moveIdea(id: string, dir: "up" | "down" | "top") {
  const queue = await getQueue();
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) return;
  if (dir === "top") { await queueIdea(id, true); return; }
  const swap = dir === "up" ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= queue.length) return;
  const a = queue[idx], b = queue[swap];
  await db.update(schema.ideas).set({ queueRank: b.queueRank }).where(eq(schema.ideas.id, a.id));
  await db.update(schema.ideas).set({ queueRank: a.queueRank }).where(eq(schema.ideas.id, b.id));
}

export async function editIdea(id: string, title: string, description: string) {
  await db.update(schema.ideas)
    .set({ title: title.trim().slice(0, 200), description: (description || title).trim().slice(0, 4000), analysis: null, status: "evaluating", updatedAt: nowIso() })
    .where(eq(schema.ideas.id, id));
  setImmediate(() => { analyseIdea(id).catch(() => {}); });
}

/** Ideas waiting to be built, in build order (evaluating ones included so the user sees them). */
export async function getQueue(): Promise<IdeaRow[]> {
  return db.select().from(schema.ideas)
    .where(inArray(schema.ideas.status, ["queued", "evaluating"]))
    .orderBy(asc(schema.ideas.queueRank), asc(schema.ideas.createdAt));
}

/** The idea the next cycle will build, if any. Ideas still being analysed are skipped. */
export async function peekNext(): Promise<IdeaRow | null> {
  const [row] = await db.select().from(schema.ideas)
    .where(eq(schema.ideas.status, "queued"))
    .orderBy(asc(schema.ideas.queueRank), asc(schema.ideas.createdAt))
    .limit(1);
  return row || null;
}

/** Claim the next queued idea for a cycle. Returns a brief the builder can follow. */
export async function claimNext(): Promise<{ id: string; title: string; description: string; category: string } | null> {
  let next = await peekNext();
  // A freshly submitted idea may still be under analysis; give it a moment
  // rather than letting the strategist jump ahead of it.
  for (let i = 0; !next && i < 24; i++) {
    const [pending] = await db.select({ id: schema.ideas.id }).from(schema.ideas).where(eq(schema.ideas.status, "evaluating")).limit(1);
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 5000));
    next = await peekNext();
  }
  if (!next) return null;
  await db.update(schema.ideas).set({ status: "building", updatedAt: nowIso() }).where(eq(schema.ideas.id, next.id));
  return { id: next.id, ...ideaBrief(next) };
}

export function ideaBrief(idea: IdeaRow) {
  const a = parseAnalysis(idea.analysis);
  const parts = [a?.summary || idea.description];
  if (idea.description && a?.summary && a.summary !== idea.description) parts.push(`Operator's request: ${idea.description}`);
  if (a?.spec?.length) parts.push("Implementation steps:\n" + a.spec.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  if (a?.acceptance?.length) parts.push("Done when:\n" + a.acceptance.map((s) => `- ${s}`).join("\n"));
  return { title: idea.title, description: parts.join("\n\n"), category: idea.category || "feature" };
}

export async function markIdeaStarted(id: string, cycleId: string) {
  await db.update(schema.ideas).set({ pickedCycleId: cycleId, updatedAt: nowIso() }).where(eq(schema.ideas.id, id));
}

export async function finishIdea(id: string, result: { cycleId?: string; status: string; error?: string }) {
  const shipped = result.status === "completed";
  await db.update(schema.ideas).set({
    status: shipped ? "shipped" : "failed",
    pickedCycleId: result.cycleId || null,
    reason: shipped ? "Built and deployed" : (result.error || `Cycle ${result.status}`).slice(0, 500),
    updatedAt: nowIso(),
  }).where(eq(schema.ideas.id, id));
}

/** On boot, anything left "building" was interrupted by a restart: put it back at the front. */
export async function recoverInterrupted() {
  const stuck = await db.select().from(schema.ideas).where(eq(schema.ideas.status, "building"));
  for (const s of stuck) await queueIdea(s.id, true);
  const evaluating = await db.select({ id: schema.ideas.id }).from(schema.ideas).where(eq(schema.ideas.status, "evaluating"));
  for (const e of evaluating) setImmediate(() => { analyseIdea(e.id).catch(() => {}); });
  if (stuck.length || evaluating.length) log.info({ requeued: stuck.length, reanalysing: evaluating.length }, "Recovered idea queue");
}

function norm(t: string) { return t.toLowerCase().replace(/\bv\d+\b/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }

/** Everything the Ideas page needs in one call. */
export async function getBoard() {
  const [queue, building, mine, system, recent] = await Promise.all([
    getQueue(),
    db.select().from(schema.ideas).where(eq(schema.ideas.status, "building")).limit(1),
    db.select().from(schema.ideas).where(eq(schema.ideas.source, "user")).orderBy(desc(schema.ideas.createdAt)).limit(100),
    db.select().from(schema.ideas)
      .where(and(eq(schema.ideas.status, "proposed"), sql`coalesce(${schema.ideas.source}, 'system') != 'user'`))
      .orderBy(desc(schema.ideas.createdAt)).limit(400),
    db.select({ title: schema.ideas.title }).from(schema.ideas)
      .where(inArray(schema.ideas.status, ["selected", "shipped", "building", "queued", "evaluating"])),
  ]);

  // Dedupe system proposals by title (the strategist re-proposes the same things often)
  // and hide ones that were already built or queued.
  const taken = new Set(recent.map((r) => norm(r.title)));
  const seen = new Map<string, IdeaRow & { times: number }>();
  for (const s of system) {
    const k = norm(s.title);
    if (!k || taken.has(k)) continue;
    const prev = seen.get(k);
    if (prev) { prev.times++; continue; }
    seen.set(k, { ...s, times: 1 });
  }
  const systemIdeas = [...seen.values()]
    .map((s) => ({ ...s, priorityScore: score(s) }))
    .sort((a, b) => (b.priorityScore + b.times * 20) - (a.priorityScore + a.times * 20))
    .slice(0, 60);

  const next = queue.find((q) => q.status === "queued") || null;
  const mode = getEvolutionMode();

  const [lastCycle] = await db.select({ improvement: schema.evolutionCycles.selectedImprovement, status: schema.evolutionCycles.status })
    .from(schema.evolutionCycles).orderBy(desc(schema.evolutionCycles.cycleNumber)).limit(1);

  return {
    mode,
    building: building[0] || null,
    buildingCycle: building[0] ? null : lastCycle?.status === "running" ? lastCycle.improvement : null,
    next,
    nextSource: next ? "queue" : "strategist",
    nextHint: next ? null : `The strategist will choose based on the latest observations in "${mode}" mode. Add an idea or promote a suggestion to decide for it.`,
    queue,
    mine,
    system: systemIdeas,
    shippedCount: mine.filter((m) => m.status === "shipped").length,
  };
}

export async function getIdea(id: string) {
  const [row] = await db.select().from(schema.ideas).where(eq(schema.ideas.id, id));
  if (!row) return null;
  let cycle = null;
  if (row.pickedCycleId) {
    const [c] = await db.select({
      id: schema.evolutionCycles.id, cycleNumber: schema.evolutionCycles.cycleNumber, status: schema.evolutionCycles.status,
      newVersion: schema.evolutionCycles.newVersion, errorMessage: schema.evolutionCycles.errorMessage,
    }).from(schema.evolutionCycles).where(eq(schema.evolutionCycles.id, row.pickedCycleId));
    cycle = c || null;
  }
  return { ...row, cycle };
}

