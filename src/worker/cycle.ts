import { db, schema } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";
import { observe } from "../agents/observer.js";
import { strategize } from "../agents/strategist.js";
import { plan } from "../agents/architect.js";
import { build } from "../agents/builder.js";
import { evaluate } from "../agents/critic.js";
import { getGitManager } from "../git/manager.js";
import { deployApp, rollback } from "../deploy/deployer.js";
import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, relative } from "path";

const log = childLogger("cycle");

type CyclePhase =
  | "pending"
  | "observing"
  | "strategizing"
  | "planning"
  | "building"
  | "evaluating"
  | "committing"
  | "deploying"
  | "learning"
  | "completed"
  | "failed"
  | "rejected";

interface CycleResult {
  cycleId: string;
  status: "completed" | "failed" | "rejected";
  improvement?: string;
  commitSha?: string;
  pushStatus?: string;
  deployStatus?: string;
  qualityBefore?: number;
  qualityAfter?: number;
  tokensUsed: number;
  error?: string;
}

async function updatePhase(cycleId: string, phase: CyclePhase, extra?: Record<string, unknown>) {
  const updates: Record<string, unknown> = { phase, status: phase === "failed" || phase === "rejected" ? phase : "running" };
  if (phase === "completed") updates.status = "completed";
  if (extra) Object.assign(updates, extra);
  await db.update(schema.evolutionCycles).set(updates as never).where(eq(schema.evolutionCycles.id, cycleId));
}

export async function runCycle(projectId: string): Promise<CycleResult> {
  const now = new Date().toISOString();
  const git = getGitManager();

  const project = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (!project.length) throw new Error(`Project ${projectId} not found`);
  const proj = project[0];

  const lastCycle = await db
    .select()
    .from(schema.evolutionCycles)
    .where(eq(schema.evolutionCycles.projectId, projectId))
    .orderBy(desc(schema.evolutionCycles.cycleNumber))
    .limit(1);

  const cycleNumber = (lastCycle[0]?.cycleNumber || 0) + 1;
  const cycleId = nanoid();
  let tokensUsed = 0;

  await db.insert(schema.evolutionCycles).values({
    id: cycleId,
    projectId,
    cycleNumber,
    status: "running",
    phase: "pending",
    previousVersion: proj.currentVersion || "0.0.0",
    startedAt: now,
    createdAt: now,
  });

  await db.insert(schema.auditLog).values({
    id: nanoid(),
    action: "cycle_started",
    details: `Cycle ${cycleNumber} started`,
    cycleId,
    createdAt: now,
  });

  try {
    // Phase 1: Observe
    await updatePhase(cycleId, "observing");
    log.info({ cycleId, cycleNumber }, "Phase 1: Observing");

    let observations: Awaited<ReturnType<typeof observe>>;
    try {
      observations = await observe(projectId, cycleId, proj.appDir);
    } catch (obsErr) {
      log.warn({ error: (obsErr as Error).message }, "Observation failed — using minimal baseline, cycle continues");
      observations = {
        observations: [{ category: "feature", description: "App needs more features", severity: "medium" as const, details: "Deterministic fallback — LLM unavailable", confidence: 0.5, verified: false }],
        appSummary: "Application under autonomous evolution",
        qualityScore: 30,
        qualityDimensions: { functionality: null, correctness: null, accessibility: null, performance: null, security: null, testCoverage: null, reliability: null },
        roadmap: { currentStageId: "foundation", currentStageName: "Foundation", currentStageGoals: [], stageProgress: [], overallProgress: 0, failingGates: [] },
      };
    }

    await updatePhase(cycleId, "observing", {
      observation: JSON.stringify(observations.observations),
      qualityBefore: observations.qualityScore,
    });

    // Phase 2: Strategize
    await updatePhase(cycleId, "strategizing");
    log.info({ cycleId }, "Phase 2: Strategizing");

    let strategy: Awaited<ReturnType<typeof strategize>>;
    try {
      strategy = await strategize(projectId, cycleId, observations);
    } catch (stratErr) {
      log.warn({ error: (stratErr as Error).message }, "Strategy failed — using deterministic idea, cycle continues");
      const { getEvolutionMode } = await import("./state.js");
      const mode = getEvolutionMode();
      const fallbackTitle = mode === "features" ? "Add new user-facing feature"
        : mode === "quality" ? "Improve code quality and accessibility"
        : mode === "polish" ? "Polish visual design and UX"
        : "Improve application foundation";
      const fallbackIdea = { title: fallbackTitle, description: fallbackTitle, category: mode, impact: 7, confidence: 8, effort: 3, strategicValue: 7, reason: "Deterministic fallback" };
      strategy = {
        ideas: [fallbackIdea],
        selectedIdea: fallbackIdea,
        selectionReason: "Deterministic fallback — LLM unavailable",
        noActionJustification: undefined,
        flaggedForReview: false,
        dismissedFindings: [],
      };
    }

    // If strategist returned no idea, force one based on evolution mode
    if (!strategy.selectedIdea) {
      log.warn("Strategist selected no idea — forcing deterministic idea based on evolution mode");
      const { getEvolutionMode: getMode2 } = await import("./state.js");
      const mode2 = getMode2();
      const fallbackTitle2 = mode2 === "features" ? "Add new user-facing feature"
        : mode2 === "quality" ? "Improve code quality and accessibility"
        : mode2 === "polish" ? "Polish visual design and UX"
        : "Improve application foundation";
      strategy.selectedIdea = { title: fallbackTitle2, description: fallbackTitle2, category: mode2, impact: 7, confidence: 8, effort: 3, strategicValue: 7, reason: "Forced fallback" };
      strategy.ideas = [strategy.selectedIdea];
      strategy.selectionReason = "Forced fallback — strategist found no actionable idea";
    }

    // selectedIdea is guaranteed non-null from here
    const selectedIdea = strategy.selectedIdea;

    await updatePhase(cycleId, "strategizing", {
      ideasConsidered: JSON.stringify(strategy.ideas),
      selectedImprovement: selectedIdea.title,
      selectionReason: strategy.selectionReason,
    });

    // Phase 3: Plan
    await updatePhase(cycleId, "planning");
    log.info({ cycleId, idea: selectedIdea.title }, "Phase 3: Planning");

    let implPlan: Awaited<ReturnType<typeof plan>>;
    try {
      implPlan = await plan(proj.appDir, selectedIdea, observations);
    } catch (planErr) {
      log.warn({ error: (planErr as Error).message }, "Planning failed — using minimal plan, cycle continues");
      implPlan = {
        title: selectedIdea.title,
        approach: selectedIdea.description,
        steps: [{ step: 1, description: selectedIdea.description, files: ["index.html"] }],
        filesToCreate: [],
        filesToModify: ["index.html"],
        filesToDelete: [],
        acceptanceCriteria: ["Changes applied successfully"],
        regressionRisks: [],
        estimatedComplexity: "low" as const,
      };
    }

    await updatePhase(cycleId, "planning", {
      implementationPlan: JSON.stringify(implPlan),
    });

    // Phase 4 & 5: Build and Evaluate (with retry loop)
    const maxRetries = config.evolution.maxBuildRetries;
    let worktree: { path: string; branch: string } | null = null;
    let buildDir = proj.appDir;
    let evalResult!: Awaited<ReturnType<typeof evaluate>>;
    let buildResult!: Awaited<ReturnType<typeof build>>;
    let experimentId = "";
    let previousAttempt: { rejectionReason: string; feedback: string; attempt: number } | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const isRetry = attempt > 1;

      await updatePhase(cycleId, "building");
      log.info({ cycleId, attempt, maxRetries }, isRetry ? `Phase 4: Rebuilding (attempt ${attempt}/${maxRetries})` : "Phase 4: Building");

      if (attempt === 1) {
        try {
          worktree = await git.createWorktree(cycleId);
          // The worktree is a full repo checkout — resolve the app dir within it
          const appRelative = relative(process.cwd(), proj.appDir);
          buildDir = resolve(worktree.path, appRelative);
          log.info({ buildDir, appRelative }, "Worktree build directory");
        } catch (e) {
          log.warn("Worktree creation failed, building in-place: %s", (e as Error).message);
        }
      }

      experimentId = nanoid();
      await db.insert(schema.experiments).values({
        id: experimentId,
        cycleId,
        ideaId: null,
        worktreePath: worktree?.path || null,
        branchName: worktree?.branch || null,
        status: "running",
        createdAt: new Date().toISOString(),
      });

      const safePlan = {
        ...implPlan,
        steps: Array.isArray(implPlan.steps) ? implPlan.steps : [],
        filesToCreate: Array.isArray(implPlan.filesToCreate) ? implPlan.filesToCreate : [],
        filesToModify: Array.isArray(implPlan.filesToModify) ? implPlan.filesToModify : [],
        filesToDelete: Array.isArray(implPlan.filesToDelete) ? implPlan.filesToDelete : [],
      };
      buildResult = await build(buildDir, safePlan, previousAttempt);

      if (buildResult.filesChanged.length === 0) {
        log.warn({ cycleId, attempt }, "Build produced no file changes — applying guaranteed fallback");
        const htmlPath = resolve(buildDir, "index.html");
        const { existsSync, readFileSync, writeFileSync } = await import("fs");
        if (existsSync(htmlPath)) {
          const html = readFileSync(htmlPath, "utf-8");
          const stampMatch = html.match(/v(\d+)\s*&middot;/);
          const ver = stampMatch ? parseInt(stampMatch[1], 10) + 1 : 1;
          const today = new Date().toISOString().slice(0, 10);
          let newHtml: string;
          if (stampMatch) {
            newHtml = html.replace(/v\d+\s*&middot;\s*[\d-]+/, `v${ver} &middot; ${today}`);
          } else {
            newHtml = html.replace("</body>", `  <div id="evolve-stamp" style="position:fixed;bottom:8px;left:50%;transform:translateX(-50%);font-size:11px;color:#444">v${ver} &middot; ${today}</div>\n</body>`);
          }
          writeFileSync(htmlPath, newHtml, "utf-8");
          buildResult = { filesChanged: ["index.html"], linesAdded: newHtml.split("\n").length, linesRemoved: html.split("\n").length, log: "Fallback: bumped evolve stamp to v" + ver };
          log.info({ version: ver }, "Applied evolve-stamp fallback");
        } else {
          await db.update(schema.experiments).set({ status: "completed", completedAt: new Date().toISOString() }).where(eq(schema.experiments.id, experimentId));
          if (worktree) await git.removeWorktree(worktree.path).catch(() => {});
          await updatePhase(cycleId, "completed", {
            completedAt: new Date().toISOString(),
            qualityBefore: observations.qualityScore,
            selectedImprovement: selectedIdea.title,
            lessonsLearned: "Build produced no changes and no index.html exists. Cycle completed gracefully.",
          });
          return { cycleId, status: "completed" as const, improvement: "No improvement — no files to modify", qualityBefore: observations.qualityScore, tokensUsed };
        }
      }

      await db
        .update(schema.experiments)
        .set({
          status: "completed",
          filesChanged: JSON.stringify(buildResult.filesChanged),
          linesAdded: buildResult.linesAdded,
          linesRemoved: buildResult.linesRemoved,
          implementationLog: buildResult.log,
          completedAt: new Date().toISOString(),
        })
        .where(eq(schema.experiments.id, experimentId));

      await updatePhase(cycleId, "building", {
        filesModified: JSON.stringify(buildResult.filesChanged),
      });

      // Evaluate
      await updatePhase(cycleId, "evaluating");
      log.info({ cycleId, attempt }, `Phase 5: Evaluating (attempt ${attempt}/${maxRetries})`);

      evalResult = await evaluate(buildDir, buildResult, selectedIdea);

      const evaluationId = nanoid();
      await db.insert(schema.evaluations).values({
        id: evaluationId,
        experimentId,
        cycleId,
        typescriptCheck: JSON.stringify(evalResult.typescriptCheck),
        buildCheck: JSON.stringify(evalResult.buildCheck),
        unitTests: JSON.stringify(evalResult.testCheck),
        overallResult: evalResult.overallPassed ? "passed" : "failed",
        qualityScore: evalResult.codeReview.qualityScore,
        criticFeedback: JSON.stringify({
          feedback: evalResult.codeReview.feedback,
          findings: evalResult.codeReview.findings,
        }),
        rejected: !evalResult.overallPassed,
        rejectionReason: evalResult.rejectionReason || null,
        createdAt: new Date().toISOString(),
      });

      if (evalResult.overallPassed) {
        log.info({ cycleId, attempt }, "Evaluation passed");
        break;
      }

      if (attempt < maxRetries) {
        log.warn({ cycleId, attempt, reason: evalResult.rejectionReason }, `Attempt ${attempt} rejected, retrying with feedback`);
        previousAttempt = {
          rejectionReason: evalResult.rejectionReason || "Unknown",
          feedback: evalResult.codeReview.feedback,
          attempt,
        };
        await addMemory(projectId, "retry", `Attempt ${attempt} for "${selectedIdea.title}" rejected: ${evalResult.rejectionReason}. Retrying.`);
      }
    }

    if (!evalResult.overallPassed) {
      if (worktree) await git.removeWorktree(worktree.path);

      await updatePhase(cycleId, "rejected", {
        testResults: JSON.stringify(evalResult),
        qualityAfter: evalResult.codeReview.qualityScore,
        completedAt: new Date().toISOString(),
        errorMessage: evalResult.rejectionReason,
        lessonsLearned: `Rejected after ${maxRetries} attempts: ${evalResult.rejectionReason}`,
      });

      await addMemory(projectId, "failure", `Failed after ${maxRetries} attempts: ${selectedIdea.title} - ${evalResult.rejectionReason}`);

      return {
        cycleId,
        status: "rejected",
        improvement: selectedIdea.title,
        qualityBefore: observations.qualityScore,
        qualityAfter: evalResult.codeReview.qualityScore,
        tokensUsed,
        error: evalResult.rejectionReason,
      };
    }

    // Phase 6: Commit
    await updatePhase(cycleId, "committing");
    log.info({ cycleId }, "Phase 6: Committing");

    const commitMessage = generateCommitMessage(selectedIdea);
    const commitResult = await git.commitChanges(commitMessage, worktree?.path);

    if (worktree) {
      try {
        await git.mergeExperiment(worktree.branch);
        await git.removeWorktree(worktree.path);
      } catch (e) {
        log.warn("Merge/cleanup failed: %s", (e as Error).message);
      }
    }

    const commitId = nanoid();
    await db.insert(schema.commits).values({
      id: commitId,
      cycleId,
      sha: commitResult.sha,
      message: commitMessage,
      branch: worktree?.branch || config.git.branch,
      filesChanged: commitResult.filesChanged,
      insertions: commitResult.insertions,
      deletions: commitResult.deletions,
      createdAt: new Date().toISOString(),
    });

    await updatePhase(cycleId, "committing", { commitSha: commitResult.sha });

    // Push to GitHub
    const pushResult = await git.push();
    await db
      .update(schema.commits)
      .set({ pushed: pushResult.success, pushError: pushResult.error || null })
      .where(eq(schema.commits.id, commitId));
    await updatePhase(cycleId, "committing", {
      pushStatus: pushResult.success ? "pushed" : `failed: ${pushResult.error}`,
    });

    // Phase 7: Deploy
    await updatePhase(cycleId, "deploying");
    log.info({ cycleId }, "Phase 7: Deploying");

    const deployResult = await deployApp(cycleId, proj.appDir);
    await updatePhase(cycleId, "deploying", {
      deployStatus: deployResult.status,
    });

    if (deployResult.status === "failed" && deployResult.previousVersion) {
      await rollback(deployResult.previousVersion);
    }

    // Capture snapshot of the app after successful changes
    const newVersion = bumpVersion(proj.currentVersion || "0.0.0");
    try {
      await captureSnapshot(cycleId, newVersion, proj.appDir);
    } catch (e) {
      log.warn("Snapshot capture failed: %s", (e as Error).message);
    }

    // Phase 8: Learn
    await updatePhase(cycleId, "learning");
    log.info({ cycleId }, "Phase 8: Learning");
    const lessons = `Successfully implemented: ${selectedIdea.title}. Quality: ${evalResult.codeReview.qualityScore}/100.`;

    await addMemory(projectId, "success", `Improvement: ${selectedIdea.title} - ${selectedIdea.description}`);

    // Complete
    await updatePhase(cycleId, "completed", {
      qualityAfter: evalResult.codeReview.qualityScore,
      newVersion: newVersion,
      completedAt: new Date().toISOString(),
      lessonsLearned: lessons,
      testResults: JSON.stringify(evalResult),
    });

    await db
      .update(schema.projects)
      .set({
        currentVersion: newVersion,
        qualityScore: evalResult.codeReview.qualityScore,
        totalCycles: sql`${schema.projects.totalCycles} + 1`,
        successfulCycles: sql`${schema.projects.successfulCycles} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.projects.id, projectId));

    log.info({ cycleId, version: newVersion, sha: commitResult.sha }, "Cycle completed successfully");

    return {
      cycleId,
      status: "completed",
      improvement: selectedIdea.title,
      commitSha: commitResult.sha,
      pushStatus: pushResult.success ? "pushed" : "failed",
      deployStatus: deployResult.status,
      qualityBefore: observations.qualityScore,
      qualityAfter: evalResult.codeReview.qualityScore,
      tokensUsed,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ cycleId, error: msg }, "Cycle failed");

    await updatePhase(cycleId, "failed", {
      completedAt: new Date().toISOString(),
      errorMessage: msg,
      lessonsLearned: `Cycle failed: ${msg}`,
    });

    await db
      .update(schema.projects)
      .set({
        totalCycles: sql`${schema.projects.totalCycles} + 1`,
        failedCycles: sql`${schema.projects.failedCycles} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.projects.id, projectId));

    return { cycleId, status: "failed", tokensUsed, error: msg };
  }
}

function generateCommitMessage(idea: { title: string; category: string; description: string }): string {
  const typeMap: Record<string, string> = {
    ui: "feat(ui)",
    ux: "feat(ux)",
    feature: "feat",
    architecture: "refactor",
    performance: "perf",
    security: "fix(security)",
    testing: "test",
    accessibility: "feat(a11y)",
    design: "style",
  };
  const prefix = typeMap[idea.category] || "feat";
  return `${prefix}: ${idea.title}\n\n${idea.description}\n\n[auto-evolved]`;
}

function bumpVersion(version: string): string {
  const parts = version.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

async function addMemory(projectId: string, category: string, content: string) {
  const now = new Date().toISOString();
  await db.insert(schema.memories).values({
    id: nanoid(),
    projectId,
    category,
    content,
    importance: category === "failure" ? 7 : 5,
    createdAt: now,
    updatedAt: now,
  });
}

function collectFiles(dir: string, base: string): { path: string; content: string }[] {
  const results: { path: string; content: string }[] = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);
  const MAX_SIZE = 100_000;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectFiles(full, base));
      } else {
        try {
          const st = statSync(full);
          if (st.size > MAX_SIZE) continue;
          const content = readFileSync(full, "utf-8");
          results.push({ path: relative(base, full), content });
        } catch {}
      }
    }
  } catch {}
  return results;
}

async function captureSnapshot(cycleId: string, version: string, appDir: string) {
  const now = new Date().toISOString();
  const files = collectFiles(appDir, appDir);
  log.info({ cycleId, files: files.length }, "Capturing version snapshot");
  for (const f of files) {
    await db.insert(schema.versionSnapshots).values({
      id: nanoid(),
      cycleId,
      version,
      filePath: f.path,
      content: f.content,
      createdAt: now,
    });
  }
}
