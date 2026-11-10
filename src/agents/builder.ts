import { chatForTask } from "../llm/router.js";
import { childLogger } from "../core/logger.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";

const log = childLogger("builder");

interface FileChange {
  action: "create" | "modify" | "delete";
  path: string;
  content?: string;
}

interface BuildResult {
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  log: string;
}

export async function build(
  workDir: string,
  implementationPlan: {
    title: string;
    approach: string;
    steps: Array<{ step: number; description: string; files: string[] }>;
    filesToCreate: string[];
    filesToModify: string[];
    filesToDelete: string[];
  },
  previousAttempt?: {
    rejectionReason: string;
    feedback: string;
    attempt: number;
  }
): Promise<BuildResult> {
  log.info({ workDir, title: implementationPlan.title, retry: previousAttempt?.attempt }, "Starting build");

  const existingFiles: Record<string, string> = {};
  const toModify = Array.isArray(implementationPlan.filesToModify) ? implementationPlan.filesToModify : [];
  const toCreate = Array.isArray(implementationPlan.filesToCreate) ? implementationPlan.filesToCreate : [];
  for (const f of [...toModify, ...toCreate]) {
    const fullPath = resolve(workDir, f);
    if (existsSync(fullPath)) {
      try {
        existingFiles[f] = readFileSync(fullPath, "utf-8");
      } catch {}
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

CRITICAL RULES:
- Write COMPLETE file contents, not partial snippets or diffs.
- Match the EXISTING tech stack. If the app uses plain JavaScript and HTML, write JavaScript and HTML — do NOT introduce TypeScript, React, or other frameworks unless the plan explicitly says to.
- If creating a new file, include ALL necessary imports/requires.
- If modifying an existing file, include the ENTIRE updated file content, not just the changed parts.
- Keep changes minimal and focused. Do ONE thing well.
- Make sure the server can still start after your changes.
- Do NOT create test files unless the plan specifically asks for tests.`;

  let changes: FileChange[] = [];
  try {
    const result = await chatForTask("implement", [
      { role: "system", content: "You are an expert developer. Reply with ONLY valid JSON containing file changes." },
      { role: "user", content: prompt },
    ], { jsonMode: true, maxTokens: 8192 });

    const data = (result as unknown as { data: { changes: FileChange[]; summary: string } }).data;
    changes = data.changes || [];
  } catch (err) {
    log.warn({ error: (err as Error).message }, "LLM build failed — trying deterministic fallback");
    changes = getDeterministicChanges(workDir, implementationPlan.title);
    if (changes.length === 0) {
      return { filesChanged: [], linesAdded: 0, linesRemoved: 0, log: `Build skipped: LLM unavailable and no deterministic fallback (${(err as Error).message})` };
    }
    log.info({ changes: changes.length }, "Using deterministic fallback changes");
  }
  let linesAdded = 0;
  let linesRemoved = 0;
  const filesChanged: string[] = [];
  const buildLog: string[] = [];

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

    if (!change.content) continue;

    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

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

function getDeterministicChanges(workDir: string, title: string): FileChange[] {
  const titleLower = title.toLowerCase();

  // Gate: tsconfig.json
  if (titleLower.includes("tsconfig") || titleLower.includes("typescript")) {
    if (!existsSync(resolve(workDir, "tsconfig.json"))) {
      return [{
        action: "create",
        path: "tsconfig.json",
        content: JSON.stringify({
          compilerOptions: {
            target: "ES2020",
            module: "ES2020",
            moduleResolution: "node",
            strict: false,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            outDir: "./dist",
            rootDir: ".",
            allowJs: true,
            checkJs: false,
            resolveJsonModule: true,
          },
          include: ["*.ts", "*.js", "src/**/*"],
          exclude: ["node_modules", "dist"],
        }, null, 2) + "\n",
      }];
    }
  }

  // Gate: test script
  if (titleLower.includes("test")) {
    const pkgPath = resolve(workDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (!pkg.scripts?.test || pkg.scripts.test.includes("no test specified")) {
          pkg.scripts = pkg.scripts || {};
          pkg.scripts.test = "node test.js";
          const changes: FileChange[] = [
            { action: "modify", path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" },
            {
              action: "create",
              path: "test.js",
              content: `// Basic test suite for the evolving app
const http = require("http");
const assert = require("assert");

const PORT = process.env.TEST_PORT || 3099;
let serverProcess;

async function fetchJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(\`http://localhost:\${PORT}\${path}\`, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    }).on("error", reject);
  });
}

async function fetchHTML(path) {
  return new Promise((resolve, reject) => {
    http.get(\`http://localhost:\${PORT}\${path}\`, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    }).on("error", reject);
  });
}

async function runTests() {
  console.log("Running tests...");
  let passed = 0;
  let failed = 0;

  // Test 1: Health endpoint
  try {
    const res = await fetchJSON("/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, "ok");
    console.log("  ✓ GET /health returns 200 with status ok");
    passed++;
  } catch (e) {
    console.log("  ✗ GET /health:", e.message);
    failed++;
  }

  // Test 2: Homepage returns HTML
  try {
    const res = await fetchHTML("/");
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.includes("<html") || res.data.includes("<!DOCTYPE"), "Should return HTML");
    console.log("  ✓ GET / returns HTML");
    passed++;
  } catch (e) {
    console.log("  ✗ GET /:", e.message);
    failed++;
  }

  console.log(\`\\nResults: \${passed} passed, \${failed} failed\`);
  process.exit(failed > 0 ? 1 : 0);
}

// Start server, run tests, then exit
const { spawn } = require("child_process");
const server = spawn("node", ["server.js"], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "pipe",
});

server.stderr.on("data", () => {});
server.stdout.on("data", () => {});

setTimeout(async () => {
  try {
    await runTests();
  } finally {
    server.kill();
  }
}, 2000);
`,
            },
          ];
          return changes;
        }
      } catch {}
    }
  }

  // Gate: error handling
  if (titleLower.includes("error handling") || titleLower.includes("error handler")) {
    const serverPath = resolve(workDir, "server.js");
    if (existsSync(serverPath)) {
      try {
        const content = readFileSync(serverPath, "utf-8");
        if (!content.includes("catch") && !content.includes(".on(\"error\"") && !content.includes(".on('error'")) {
          const updatedContent = content.replace(
            /app\.listen\(([^)]+)\)/,
            `// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Request error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen($1)`
          );
          if (updatedContent !== content) {
            return [{ action: "modify", path: "server.js", content: updatedContent }];
          }
        }
      } catch {}
    }
  }

  // Gate: ARIA / accessibility
  if (titleLower.includes("aria") || titleLower.includes("accessibility") || titleLower.includes("semantic")) {
    const htmlPath = resolve(workDir, "index.html");
    if (existsSync(htmlPath)) {
      try {
        let content = readFileSync(htmlPath, "utf-8");
        if (!content.includes("aria-") && !content.includes("<main")) {
          content = content
            .replace("<body>", '<body>\n<main role="main" aria-label="Main content">')
            .replace("</body>", "</main>\n</body>")
            .replace(/<h1>/g, '<h1 aria-level="1">')
            .replace(/<p>/g, '<p role="text">');
          return [{ action: "modify", path: "index.html", content }];
        }
      } catch {}
    }
  }

  // Gate: interactivity (add script tag)
  if (titleLower.includes("interactiv") || titleLower.includes("javascript") || titleLower.includes("client-side")) {
    const htmlPath = resolve(workDir, "index.html");
    if (existsSync(htmlPath)) {
      try {
        let content = readFileSync(htmlPath, "utf-8");
        if (!content.includes("<script")) {
          const script = `
<script>
  document.addEventListener("DOMContentLoaded", () => {
    // Fetch and display server status
    async function updateStatus() {
      try {
        const res = await fetch("/health");
        const data = await res.json();
        const el = document.getElementById("status");
        if (el) {
          el.textContent = "Status: " + data.status + " | v" + (data.version || "0.1.0");
          el.style.color = data.status === "ok" ? "#5ee0c8" : "#ff6b6b";
        }
      } catch (e) {
        const el = document.getElementById("status");
        if (el) { el.textContent = "Status: offline"; el.style.color = "#ff6b6b"; }
      }
    }
    updateStatus();
    setInterval(updateStatus, 30000);
  });
</script>`;
          content = content.replace("</body>", `  <p id="status" style="margin-top:16px;font-size:12px;color:#666">Loading status...</p>\n${script}\n</body>`);
          return [{ action: "modify", path: "index.html", content }];
        }
      } catch {}
    }
  }

  log.warn({ title }, "No deterministic fallback for this improvement");
  return [];
}
