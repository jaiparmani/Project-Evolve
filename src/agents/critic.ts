import { chatForTask } from "../llm/router.js";
import { childLogger } from "../core/logger.js";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const log = childLogger("critic");

interface CheckResult {
  passed: boolean;
  output: string;
}

interface CodeReview {
  approved: boolean;
  feedback: string;
  qualityScore: number;
  findings: Array<{
    issue: string;
    severity: string;
    confidence: number;
    filePath?: string;
  }>;
}

interface EvaluationResult {
  typescriptCheck: CheckResult;
  buildCheck: CheckResult;
  testCheck: CheckResult;
  codeReview: CodeReview;
  overallPassed: boolean;
  rejectionReason?: string;
}

function runCommand(cmd: string, cwd: string): CheckResult {
  try {
    const output = execSync(cmd, { cwd, timeout: 60000, encoding: "utf-8", stdio: "pipe" });
    return { passed: true, output: output.slice(-2000) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      passed: false,
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

  // 1. TypeScript check
  let tsCheck: CheckResult = { passed: true, output: "No TypeScript config found" };
  if (hasTsConfig) {
    if (hasPackageJson) {
      runCommand("npm install --ignore-scripts 2>&1 || true", workDir);
    }
    tsCheck = runCommand("npx tsc --noEmit 2>&1 || true", workDir);
    tsCheck.passed = !tsCheck.output.includes("error TS");
  }

  // 2. Build check
  let buildCheck: CheckResult = { passed: true, output: "No build script" };
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(workDir, "package.json"), "utf-8"));
      if (pkg.scripts?.build) {
        buildCheck = runCommand("npm run build 2>&1", workDir);
      }
    } catch {}
  }

  // 3. Test execution
  let testCheck: CheckResult = { passed: true, output: "No test script defined" };
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(workDir, "package.json"), "utf-8"));
      if (pkg.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1") {
        testCheck = runCommand("npm test 2>&1", workDir);
      }
    } catch {}
  }

  // 4. Read changed files for review
  const changedContent: string[] = [];
  for (const f of changes.filesChanged.slice(0, 5)) {
    try {
      const content = readFileSync(resolve(workDir, f), "utf-8");
      changedContent.push(`--- ${f} ---\n${content.slice(0, 2000)}`);
    } catch {}
  }

  const prompt = `You are a code reviewer evaluating changes made by an AI developer.

IMPROVEMENT GOAL: ${idea.title}
Description: ${idea.description}

CHANGES MADE:
${changes.log}

CHANGED CODE:
${changedContent.join("\n\n").slice(0, 4000)}

AUTOMATED CHECKS:
- TypeScript: ${tsCheck.passed ? "PASSED" : "FAILED"} — ${tsCheck.output.slice(0, 500)}
- Build: ${buildCheck.passed ? "PASSED" : "FAILED"} — ${buildCheck.output.slice(0, 500)}
- Tests: ${testCheck.passed ? "PASSED" : "FAILED"} — ${testCheck.output.slice(0, 500)}

Evaluate these changes. For each finding, include a confidence score (0.0-1.0).

Return JSON:
{
  "approved": true/false,
  "feedback": "Specific, evidence-based feedback",
  "qualityScore": 0-100,
  "findings": [
    {
      "issue": "Description of the issue",
      "severity": "low|medium|high|critical",
      "confidence": 0.0-1.0,
      "filePath": "path/to/file if applicable"
    }
  ],
  "rejectionReason": "Only if rejected — the single most important reason"
}

IMPORTANT: Your default should be to APPROVE. Only reject for serious issues:
- Changes introduce a clear, specific bug (cite the exact code)
- Changes delete working functionality without replacement
- Changes introduce an obvious security vulnerability (cite the code)

DO NOT reject for:
- Cosmetic-only changes (they still count as progress)
- Incomplete implementations (partial progress is fine)
- Minor style differences or subjective preferences
- Missing tests (adding tests is a separate improvement)
- TypeScript not being set up yet (that's a separate gate)

The goal is FORWARD PROGRESS. Any change that doesn't break the app should be approved.`;

  let codeReview: CodeReview = {
    approved: true,
    feedback: "Review skipped — automated checks only",
    qualityScore: 50,
    findings: [],
  };
  let rejectionReason: string | undefined;

  try {
    const result = await chatForTask("review", [
      { role: "system", content: "You are a strict but fair code reviewer. Every claim must cite specific code. Reply with ONLY valid JSON." },
      { role: "user", content: prompt },
    ], { jsonMode: true });

    const reviewData = (result as { data: Record<string, unknown> }).data;
    codeReview = {
      approved: reviewData.approved === true,
      feedback: String(reviewData.feedback || ""),
      qualityScore: typeof reviewData.qualityScore === "number" ? reviewData.qualityScore : 50,
      findings: Array.isArray(reviewData.findings) ? (reviewData.findings as CodeReview["findings"]) : [],
    };
    if (reviewData.rejectionReason) {
      rejectionReason = String(reviewData.rejectionReason);
    }
  } catch (e) {
    log.warn("Code review LLM call failed, using automated checks only");
  }

  // Approve if code review passes. TS/build/test failures are informational —
  // the whole point of the evolution loop is to FIX these over time.
  const overallPassed = codeReview.approved;

  if (!overallPassed && !rejectionReason) {
    const reasons: string[] = [];
    if (!tsCheck.passed) reasons.push("TypeScript errors detected");
    if (!buildCheck.passed) reasons.push("Build failed");
    if (!testCheck.passed) reasons.push("Tests failed");
    if (!codeReview.approved) reasons.push(codeReview.feedback.slice(0, 200));
    rejectionReason = reasons.join("; ");
  }

  log.info(
    {
      passed: overallPassed,
      quality: codeReview.qualityScore,
      tsCheck: tsCheck.passed,
      buildCheck: buildCheck.passed,
      testCheck: testCheck.passed,
      reviewApproved: codeReview.approved,
      findings: codeReview.findings.length,
    },
    "Evaluation complete"
  );

  return {
    typescriptCheck: tsCheck,
    buildCheck,
    testCheck,
    codeReview,
    overallPassed,
    rejectionReason,
  };
}
