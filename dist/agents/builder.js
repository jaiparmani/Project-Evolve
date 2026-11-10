import { chatForTask } from "../llm/router.js";
import { childLogger } from "../core/logger.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
const log = childLogger("builder");
export async function build(workDir, implementationPlan, previousAttempt) {
    log.info({ workDir, title: implementationPlan.title, retry: previousAttempt?.attempt }, "Starting build");
    const existingFiles = {};
    const toModify = Array.isArray(implementationPlan.filesToModify) ? implementationPlan.filesToModify : [];
    const toCreate = Array.isArray(implementationPlan.filesToCreate) ? implementationPlan.filesToCreate : [];
    for (const f of [...toModify, ...toCreate]) {
        const fullPath = resolve(workDir, f);
        if (existsSync(fullPath)) {
            try {
                existingFiles[f] = readFileSync(fullPath, "utf-8");
            }
            catch { }
        }
    }
    const existingContext = Object.entries(existingFiles)
        .map(([path, content]) => `--- ${path} ---\n${content.slice(0, 2000)}`)
        .join("\n\n");
    const retryContext = previousAttempt
        ? `\n\nPREVIOUS ATTEMPT #${previousAttempt.attempt} WAS REJECTED:
Rejection reason: ${previousAttempt.rejectionReason}
Reviewer feedback: ${previousAttempt.feedback}

You MUST fix the issues described above. Do not repeat the same mistakes. Address each point from the reviewer feedback specifically.\n`
        : "";
    const prompt = `You are a senior developer implementing changes to an application.
${retryContext}
IMPLEMENTATION PLAN:
Title: ${implementationPlan.title}
Approach: ${implementationPlan.approach}

Steps:
${implementationPlan.steps.map((s) => `${s.step}. ${s.description} (files: ${s.files.join(", ")})`).join("\n")}

Files to create: ${toCreate.join(", ") || "none"}
Files to modify: ${toModify.join(", ") || "none"}
Files to delete: ${(Array.isArray(implementationPlan.filesToDelete) ? implementationPlan.filesToDelete : []).join(", ") || "none"}

EXISTING FILE CONTENTS:
${existingContext.slice(0, 5000) || "No existing files"}

Generate the file changes. Return JSON:
{
  "changes": [
    {
      "action": "create|modify|delete",
      "path": "relative/path/to/file",
      "content": "full file content (for create/modify)"
    }
  ],
  "summary": "What was done"
}

Write production-quality TypeScript/React/CSS. Use modern patterns.
For HTML/React: use semantic elements, Tailwind CSS classes, responsive design.
Do NOT create test-only files or mocks.
Write complete file contents, not partial snippets.`;
    let changes = [];
    try {
        const result = await chatForTask("implement", [
            { role: "system", content: "You are an expert developer. Reply with ONLY valid JSON containing file changes." },
            { role: "user", content: prompt },
        ], { jsonMode: true, maxTokens: 8192 });
        const data = result.data;
        changes = data.changes || [];
    }
    catch (err) {
        log.warn({ error: err.message }, "LLM build failed — returning empty changeset");
        return { filesChanged: [], linesAdded: 0, linesRemoved: 0, log: `Build skipped: LLM unavailable (${err.message})` };
    }
    let linesAdded = 0;
    let linesRemoved = 0;
    const filesChanged = [];
    const buildLog = [];
    for (const change of changes) {
        const fullPath = resolve(workDir, change.path);
        if (change.action === "delete") {
            if (existsSync(fullPath)) {
                const old = readFileSync(fullPath, "utf-8");
                linesRemoved += old.split("\n").length;
                unlinkSync(fullPath);
                filesChanged.push(change.path);
                buildLog.push(`Deleted: ${change.path}`);
            }
            continue;
        }
        if (!change.content)
            continue;
        const dir = dirname(fullPath);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        if (change.action === "modify" && existsSync(fullPath)) {
            const old = readFileSync(fullPath, "utf-8");
            linesRemoved += old.split("\n").length;
        }
        writeFileSync(fullPath, change.content, "utf-8");
        linesAdded += change.content.split("\n").length;
        filesChanged.push(change.path);
        buildLog.push(`${change.action === "create" ? "Created" : "Modified"}: ${change.path}`);
    }
    log.info({ files: filesChanged.length, added: linesAdded, removed: linesRemoved }, "Build complete");
    return {
        filesChanged,
        linesAdded,
        linesRemoved,
        log: buildLog.join("\n"),
    };
}
//# sourceMappingURL=builder.js.map