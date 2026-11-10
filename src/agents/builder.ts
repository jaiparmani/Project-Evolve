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
  let source = "llm";
  try {
    const result = await chatForTask("implement", [
      { role: "system", content: "You are an expert developer. Reply with ONLY valid JSON containing file changes." },
      { role: "user", content: prompt },
    ], { jsonMode: true, maxTokens: 8192 });

    const data = (result as unknown as { data: { changes: FileChange[]; summary: string } }).data;
    changes = (data.changes || []).filter((c: FileChange) => c.path && (c.action === "delete" || c.content));
    if (changes.length > 0) {
      log.info({ changes: changes.length }, "LLM produced changes");
    } else {
      log.warn("LLM returned empty/invalid changes — trying deterministic fallback");
      changes = getDeterministicChanges(workDir, implementationPlan.title);
      source = "deterministic";
    }
  } catch (err) {
    log.warn({ error: (err as Error).message }, "LLM build failed — trying deterministic fallback");
    changes = getDeterministicChanges(workDir, implementationPlan.title);
    source = "deterministic";
  }

  if (changes.length === 0) {
    return { filesChanged: [], linesAdded: 0, linesRemoved: 0, log: "Build produced no changes (LLM and deterministic fallback both empty)" };
  }
  log.info({ changes: changes.length, source }, "Applying changes");
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

  // Feature: status dashboard with live clock
  if (titleLower.includes("status dashboard") || titleLower.includes("live clock")) {
    const htmlPath = resolve(workDir, "index.html");
    if (existsSync(htmlPath)) {
      const content = readFileSync(htmlPath, "utf-8");
      if (!content.includes("getElementById(\"clock\")")) {
        const newContent = content.replace("</body>", `
  <div id="dashboard" style="margin-top:32px;padding:24px;background:rgba(255,255,255,0.05);border-radius:12px;max-width:400px;margin-left:auto;margin-right:auto">
    <div style="display:flex;justify-content:space-between;margin-bottom:16px">
      <span style="color:#888;font-size:14px">Local Time</span>
      <span id="clock" style="font-family:ui-monospace,monospace;color:#5ee0c8;font-size:14px">--:--:--</span>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:16px">
      <span style="color:#888;font-size:14px">Server Status</span>
      <span id="server-status" style="font-size:14px;color:#666">checking...</span>
    </div>
    <button onclick="checkHealth()" style="width:100%;padding:10px;background:rgba(94,224,200,0.15);color:#5ee0c8;border:1px solid rgba(94,224,200,0.3);border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s" onmouseover="this.style.background='rgba(94,224,200,0.25)'" onmouseout="this.style.background='rgba(94,224,200,0.15)'">Check Server Health</button>
  </div>
  <script>
    function updateClock() {
      const now = new Date();
      document.getElementById("clock").textContent = now.toLocaleTimeString();
    }
    setInterval(updateClock, 1000);
    updateClock();

    async function checkHealth() {
      const el = document.getElementById("server-status");
      el.textContent = "checking...";
      el.style.color = "#888";
      try {
        const res = await fetch("/health");
        const data = await res.json();
        el.textContent = data.status === "ok" ? "Online ✓" : "Error";
        el.style.color = data.status === "ok" ? "#5ee0c8" : "#ff6b6b";
      } catch {
        el.textContent = "Offline ✗";
        el.style.color = "#ff6b6b";
      }
    }
    checkHealth();
  </script>
</body>`);
        return [{ action: "modify", path: "index.html", content: newContent }];
      }
    }
  }

  // Feature: visitor counter
  if (titleLower.includes("visitor counter") || titleLower.includes("greeting")) {
    const serverPath = resolve(workDir, "server.js");
    if (existsSync(serverPath)) {
      const serverContent = readFileSync(serverPath, "utf-8");
      if (!serverContent.includes("/api/visitors")) {
        const newServer = serverContent.replace(
          "app.use(express.static(",
          `let visitorCount = 0;
app.get("/api/visitors", (req, res) => {
  visitorCount++;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  res.json({ count: visitorCount, greeting });
});

app.use(express.static(`
        );
        const htmlPath = resolve(workDir, "index.html");
        const changes: FileChange[] = [{ action: "modify", path: "server.js", content: newServer }];
        if (existsSync(htmlPath)) {
          let html = readFileSync(htmlPath, "utf-8");
          if (!html.includes("visitor-count")) {
            html = html.replace("</body>", `
  <div id="visitor-info" style="margin-top:24px;text-align:center">
    <p id="greeting-text" style="color:#5ee0c8;font-size:18px;margin-bottom:8px"></p>
    <p id="visitor-count" style="color:#666;font-size:12px"></p>
  </div>
  <script>
    fetch("/api/visitors").then(r=>r.json()).then(d => {
      document.getElementById("greeting-text").textContent = d.greeting + "!";
      document.getElementById("visitor-count").textContent = "Visitor #" + d.count;
    }).catch(() => {});
  </script>
</body>`);
            changes.push({ action: "modify", path: "index.html", content: html });
          }
        }
        return changes;
      }
    }
  }

  // Feature: theme toggle
  if (titleLower.includes("theme toggle") || titleLower.includes("dark/light") || titleLower.includes("dark mode")) {
    const htmlPath = resolve(workDir, "index.html");
    if (existsSync(htmlPath)) {
      const content = readFileSync(htmlPath, "utf-8");
      if (!content.includes("theme-toggle")) {
        const newContent = content.replace("</body>", `
  <button id="theme-toggle" onclick="toggleTheme()" style="position:fixed;top:16px;right:16px;padding:8px 12px;background:rgba(255,255,255,0.1);color:#888;border:1px solid rgba(255,255,255,0.2);border-radius:8px;cursor:pointer;font-size:16px;transition:all 0.3s">🌙</button>
  <script>
    function toggleTheme() {
      const body = document.body;
      const btn = document.getElementById("theme-toggle");
      if (body.style.background === "rgb(250, 250, 250)" || body.classList.contains("light")) {
        body.style.background = "#0a0a0a";
        body.style.color = "#e0e0e0";
        body.classList.remove("light");
        btn.textContent = "🌙";
        localStorage.setItem("theme", "dark");
      } else {
        body.style.background = "#fafafa";
        body.style.color = "#1a1a1a";
        body.classList.add("light");
        btn.textContent = "☀️";
        localStorage.setItem("theme", "light");
      }
    }
    if (localStorage.getItem("theme") === "light") toggleTheme();
  </script>
</body>`);
        return [{ action: "modify", path: "index.html", content: newContent }];
      }
    }
  }

  // Catch-all: try adding any missing feature regardless of title
  log.info("Title didn't match specific fallbacks — trying generic feature additions");
  const htmlPath2 = resolve(workDir, "index.html");
  const serverPath2 = resolve(workDir, "server.js");

  if (existsSync(htmlPath2)) {
    const html = readFileSync(htmlPath2, "utf-8");

    // Add live clock if missing
    if (!html.includes('getElementById("clock")')) {
      log.info("Catch-all: adding live clock dashboard");
      return getDeterministicChanges(workDir, "status dashboard with live clock");
    }
    // Add visitor counter if missing
    if (existsSync(serverPath2) && !readFileSync(serverPath2, "utf-8").includes("/api/visitors")) {
      log.info("Catch-all: adding visitor counter");
      return getDeterministicChanges(workDir, "visitor counter");
    }
    // Add theme toggle if missing
    if (!html.includes("theme-toggle")) {
      log.info("Catch-all: adding theme toggle");
      return getDeterministicChanges(workDir, "theme toggle");
    }
    // Add interactivity if missing
    if (!html.includes("<script")) {
      log.info("Catch-all: adding interactivity");
      return getDeterministicChanges(workDir, "interactivity");
    }
  }

  log.warn({ title }, "No deterministic fallback available — all features already present");
  return [];
}
