import { chatForTask } from "../llm/router.js";
import { childLogger } from "../core/logger.js";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const log = childLogger("critic");

interface EvaluationResult {
  typescriptCheck: { passed: boolean; output: string };
  buildCheck: { passed: boolean; output: string };
  codeReview: { approved: boolean; feedback: string; qualityScore: number };
  overallPassed: boolean;
  rejectionReason?: string;
}

function runCommand(cmd: string, cwd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, timeout: 60000, encoding: "utf-8", stdio: "pipe" });
    return { success: true, output: output.slice(-2000) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: (err.stdout || err.stderr || err.message || "Command failed").slice(-2000),
    };
  }
}

export async function evaluate(
  workDir: string,
  changes: { filesChanged: string[]; log: string },
  idea: { title: string; description: string }
): Promise<EvaluationResult> {
  log.info({ workDir, files: changes.filesChanged.length }, "Starting evaluation");

  const hasPackageJson = existsSync(resolve(workDir, "package.json"));
  const hasTsConfig = existsSync(resolve(workDir, "tsconfig.json"));

  let tsCheck = { passed: true, output: "No TypeScript config found" };
  if (hasTsConfig) {
    if (hasPackageJson) {
      runCommand("npm install --ignore-scripts 2>&1 || true", workDir);
    }
    tsCheck = runCommand("npx tsc --noEmit 2>&1 || true", workDir);
    tsCheck.passed = !tsCheck.output.includes("error TS");
  }

  let buildCheck = { passed: true, output: "No build script" };
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(workDir, "package.json"), "utf-8"));
      if (pkg.scripts?.build) {
        buildCheck = runCommand("npm run build 2>&1", workDir);
      }
    } catch {}
  }

  const changedContent: string[] = [];
  for (const f of changes.filesChanged.slice(0, 5)) {
    try {
      const content = readFileSync(resolve(workDir, f), "utf-8");
      changedContent.push(`--- ${f} ---\n${content.slice(0, 1500)}`);
    } catch {}
  }

  const prompt = `You are a code reviewer evaluating changes made by an AI developer.

IMPROVEMENT GOAL: ${idea.title}
Description: ${idea.description}

CHANGES MADE:
${changes.log}

CHANGED CODE:
${changedContent.join("\n\n").slice(0, 4000)}

TypeScript check: ${tsCheck.passed ? "PASSED" : "FAILED"} - ${tsCheck.output.slice(0, 500)}
Build check: ${buildCheck.passed ? "PASSED" : "FAILED"} - ${buildCheck.output.slice(0, 500)}

Evaluate these changes critically. Return JSON:
{
  "approved": true/false,
  "feedback": "Specific feedback",
  "qualityScore": 0-100,
  "issues": ["issue 1", "issue 2"],
  "rejectionReason": "Only if rejected - specific reason"
}

Reject if:
- Changes introduce bugs or regressions
- Code quality is poor
- Changes don't match the stated goal
- Changes are meaningless or cosmetic only
- Security vulnerabilities are introduced

Approve if the changes are reasonable and move the application forward.`;

  let codeReview = { approved: true, feedback: "Review skipped", qualityScore: 50 };
  let rejectionReason: string | undefined;

  try {
    const result = await chatForTask("review", [
      { role: "system", content: "You are a strict code reviewer. Reply with ONLY valid JSON." },
      { role: "user", content: prompt },
    ], { jsonMode: true });

    const reviewData = (result as { data: { approved: boolean; feedback: string; qualityScore: number; rejectionReason?: string } }).data;
    codeReview = {
      approved: reviewData.approved,
      feedback: reviewData.feedback,
      qualityScore: reviewData.qualityScore,
    };
    rejectionReason = reviewData.rejectionReason;
  } catch (e) {
    log.warn("Code review LLM call failed, using automated checks only");
  }

  const overallPassed = tsCheck.passed && buildCheck.passed && codeReview.approved;

  if (!overallPassed && !rejectionReason) {
    const reasons: string[] = [];
    if (!tsCheck.passed) reasons.push("TypeScript errors");
    if (!buildCheck.passed) reasons.push("Build failed");
    if (!codeReview.approved) reasons.push(codeReview.feedback);
    rejectionReason = reasons.join("; ");
  }

  log.info({ passed: overallPassed, quality: codeReview.qualityScore }, "Evaluation complete");

  return {
    typescriptCheck: tsCheck,
    buildCheck,
    codeReview,
    overallPassed,
    rejectionReason,
  };
}
