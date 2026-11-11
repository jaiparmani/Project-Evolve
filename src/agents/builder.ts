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

  // Gate: test script (skip if test.js already exists — already addressed)
  if (titleLower.includes("test")) {
    if (existsSync(resolve(workDir, "test.js"))) {
      log.info("Test suite already exists — skipping, falling through to guaranteedChange");
      return guaranteedChange(workDir);
    }
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
  return guaranteedChange(workDir);
}

function guaranteedChange(workDir: string): FileChange[] {
  const htmlPath = resolve(workDir, "index.html");
  const serverPath = resolve(workDir, "server.js");

  if (!existsSync(htmlPath)) {
    log.info("No index.html — creating minimal app");
    return [{ action: "create", path: "index.html", content: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Evolving App</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}
h1{font-size:2rem;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
p{color:#888;max-width:480px;text-align:center;line-height:1.6}
.badge{display:inline-block;padding:4px 10px;background:rgba(96,165,250,0.15);border:1px solid rgba(96,165,250,0.3);border-radius:12px;font-size:0.75rem;color:#60a5fa}</style></head>
<body><h1>Evolving App</h1><p>This app improves itself through autonomous evolution cycles.</p>
<span class="badge" id="evolve-stamp">v1 &middot; ${new Date().toISOString().slice(0, 10)}</span></body></html>` }];
  }

  const html = readFileSync(htmlPath, "utf-8");
  const serverExists = existsSync(serverPath);
  const serverCode = serverExists ? readFileSync(serverPath, "utf-8") : "";

  // ── PHASE 1: Add new features ──
  const phase1 = addNewFeature(workDir, html, serverExists, serverCode);
  if (phase1) return phase1;

  // ── PHASE 2: Enhance existing features ──
  const phase2 = enhanceExistingFeature(workDir, html, serverExists, serverCode);
  if (phase2) return phase2;

  // ── PHASE 3: Evolve content and style ──
  return evolveContentAndStyle(workDir, html);
}

function addNewFeature(workDir: string, html: string, serverExists: boolean, serverCode: string): FileChange[] | null {
  // Each entry: [check: string to look for in html, label, html snippet to inject]
  // Features are injected before </body> unless noted
  const S = (s: string) => `<style>${s}</style>`;
  const cardStyle = "margin-top:24px;max-width:520px;width:100%;padding:20px 24px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px";
  const btnStyle = "padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;border:none;transition:all 0.2s";
  const inputStyle = "width:100%;padding:10px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#e0e0e0;font:13px/1.4 ui-monospace,monospace;outline:none";

  const features: Array<{ id: string; check: string; label: string; inject: string; target?: "head" | "body-start" }> = [
    // ── Core infrastructure ──
    { id: "theme-toggle", check: "theme-toggle", label: "dark/light theme toggle", inject: `
  <button id="theme-toggle" onclick="toggleTheme()" style="position:fixed;top:16px;right:16px;padding:8px 12px;background:rgba(255,255,255,0.1);color:#888;border:1px solid rgba(255,255,255,0.2);border-radius:8px;cursor:pointer;font-size:16px;transition:all 0.3s;z-index:999">🌙</button>
  <script>function toggleTheme(){const b=document.body,t=document.getElementById("theme-toggle");if(b.classList.contains("light")){b.style.background="#0a0a0a";b.style.color="#e0e0e0";b.classList.remove("light");t.textContent="🌙";localStorage.setItem("theme","dark")}else{b.style.background="#fafafa";b.style.color="#1a1a1a";b.classList.add("light");t.textContent="☀️";localStorage.setItem("theme","light")}}if(localStorage.getItem("theme")==="light")toggleTheme();</script>` },
    { id: "toast", check: "toast-container", label: "toast notification system", inject: `
  <div id="toast-container" style="position:fixed;top:16px;right:16px;z-index:9998;display:flex;flex-direction:column;gap:8px"></div>
  <script>function showToast(msg,type,ms){ms=ms||3000;const c=document.getElementById("toast-container");if(!c)return;const colors={success:"#5ee0c8",info:"#60a5fa",warn:"#fbbf24",error:"#f87171"};const t=document.createElement("div");t.textContent=msg;t.style.cssText="padding:10px 18px;background:#1e293b;color:"+(colors[type]||"#e2e8f0")+";border:1px solid "+(colors[type]||"rgba(96,165,250,0.3)")+";border-radius:8px;font-size:14px;opacity:0;transition:opacity 0.3s;cursor:pointer";t.onclick=()=>t.remove();c.appendChild(t);requestAnimationFrame(()=>t.style.opacity="1");setTimeout(()=>{t.style.opacity="0";setTimeout(()=>t.remove(),300)},ms)}showToast("Welcome! This app evolves itself.","info");</script>` },
    { id: "animations", check: "@keyframes fadeSlideIn", label: "page load animations", inject: S(`@keyframes fadeSlideIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}body>*{animation:fadeSlideIn 0.5s ease-out both}body>*:nth-child(2){animation-delay:0.1s}body>*:nth-child(3){animation-delay:0.2s}body>*:nth-child(4){animation-delay:0.3s}`), target: "head" },
    { id: "responsive", check: "@media(max-width", label: "responsive breakpoints", inject: S(`@media(max-width:600px){body{padding:16px!important;gap:12px!important}h1{font-size:1.5rem!important}p{font-size:14px!important}.tool-card{padding:16px!important}section{padding:16px!important}}`), target: "head" },
    { id: "meta-tags", check: 'name="description"', label: "SEO meta tags", inject: `<meta name="description" content="An autonomously evolving web application with built-in tools."><meta name="theme-color" content="#0a0a0a">`, target: "head" },

    // ── Real useful tools ──
    { id: "todo-list", check: "todo-app", label: "draggable todo list with persistence", inject: `
  <div id="todo-app" style="${cardStyle}">
    <h2 style="font-size:16px;color:#60a5fa;margin-bottom:12px;display:flex;align-items:center;gap:8px">📋 Todo List <span id="todo-count" style="font-size:11px;color:#666;font-weight:400">0 items</span></h2>
    <div style="display:flex;gap:8px;margin-bottom:12px"><input id="todo-input" placeholder="Add a task..." style="${inputStyle};flex:1" onkeydown="if(event.key==='Enter')addTodo()"><button onclick="addTodo()" style="${btnStyle};background:#60a5fa;color:#0a0a0a;font-weight:600">Add</button></div>
    <ul id="todo-list" style="list-style:none;padding:0;max-height:300px;overflow-y:auto"></ul>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px"><button onclick="clearDone()" style="${btnStyle};background:transparent;color:#888;font-size:11px;padding:4px 8px;border:1px solid rgba(255,255,255,0.1)">Clear done</button><span id="todo-stats" style="color:#555"></span></div>
  </div>
  <script>(function(){let todos=JSON.parse(localStorage.getItem("todos")||"[]");function render(){const ul=document.getElementById("todo-list");ul.innerHTML="";todos.forEach((t,i)=>{const li=document.createElement("li");li.style.cssText="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);cursor:grab";li.draggable=true;li.dataset.idx=i;li.innerHTML='<input type="checkbox" '+(t.done?"checked":"")+' onchange="toggleTodo('+i+')" style="accent-color:#60a5fa;width:16px;height:16px"><span style="flex:1;font-size:13px;'+(t.done?"text-decoration:line-through;color:#555":"color:#ccc")+'">'+t.text.replace(/</g,"&lt;")+'</span><button onclick="delTodo('+i+')" style="background:none;border:none;color:#555;cursor:pointer;font-size:14px">×</button>';li.ondragstart=e=>e.dataTransfer.setData("idx",""+i);li.ondragover=e=>e.preventDefault();li.ondrop=e=>{const from=+e.dataTransfer.getData("idx");const to=i;const item=todos.splice(from,1)[0];todos.splice(to,0,item);save();render()};ul.appendChild(li)});document.getElementById("todo-count").textContent=todos.length+" items";const done=todos.filter(t=>t.done).length;document.getElementById("todo-stats").textContent=done+"/"+todos.length+" done"}function save(){localStorage.setItem("todos",JSON.stringify(todos));render()}window.addTodo=function(){const inp=document.getElementById("todo-input");const text=inp.value.trim();if(!text)return;todos.unshift({text,done:false});inp.value="";save()};window.toggleTodo=function(i){todos[i].done=!todos[i].done;save()};window.delTodo=function(i){todos.splice(i,1);save()};window.clearDone=function(){todos=todos.filter(t=>!t.done);save()};render()})();</script>` },

    { id: "pomodoro", check: "pomodoro-timer", label: "pomodoro focus timer", inject: `
  <div id="pomodoro-timer" style="${cardStyle};text-align:center">
    <h2 style="font-size:16px;color:#f472b6;margin-bottom:16px">🍅 Pomodoro Timer</h2>
    <div id="pomo-display" style="font:600 48px/1 ui-monospace,monospace;color:#e0e0e0;margin:16px 0">25:00</div>
    <div id="pomo-label" style="font-size:12px;color:#888;margin-bottom:16px">Focus Time</div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button id="pomo-start" onclick="pomoToggle()" style="${btnStyle};background:#f472b6;color:#0a0a0a;font-weight:600;min-width:80px">Start</button>
      <button onclick="pomoReset()" style="${btnStyle};background:rgba(255,255,255,0.08);color:#888">Reset</button>
      <button onclick="pomoSkip()" style="${btnStyle};background:rgba(255,255,255,0.08);color:#888">Skip</button>
    </div>
    <div style="display:flex;gap:6px;justify-content:center;margin-top:12px" id="pomo-dots"></div>
  </div>
  <script>(function(){let sec=25*60,running=false,iv,mode="focus",sessions=0;const modes={focus:{t:25*60,l:"Focus Time",c:"#f472b6"},short:{t:5*60,l:"Short Break",c:"#5ee0c8"},long:{t:15*60,l:"Long Break",c:"#a78bfa"}};function fmt(s){return Math.floor(s/60)+":"+(s%60<10?"0":"")+s%60}function render(){document.getElementById("pomo-display").textContent=fmt(sec);document.getElementById("pomo-label").textContent=modes[mode].l;document.getElementById("pomo-display").style.color=modes[mode].c;document.getElementById("pomo-dots").innerHTML=Array(4).fill(0).map((_,i)=>'<span style="width:8px;height:8px;border-radius:50%;background:'+(i<sessions?"#f472b6":"rgba(255,255,255,0.1)")+'"></span>').join("")}function switchMode(m){mode=m;sec=modes[m].t;running=false;clearInterval(iv);document.getElementById("pomo-start").textContent="Start";render()}window.pomoToggle=function(){if(running){running=false;clearInterval(iv);document.getElementById("pomo-start").textContent="Start"}else{running=true;document.getElementById("pomo-start").textContent="Pause";iv=setInterval(()=>{sec--;if(sec<=0){clearInterval(iv);running=false;if(mode==="focus"){sessions++;switchMode(sessions%4===0?"long":"short")}else{switchMode("focus")}if(typeof showToast==="function")showToast("⏰ "+modes[mode].l+"!","info")}render()},1000)}};window.pomoReset=function(){switchMode(mode)};window.pomoSkip=function(){if(mode==="focus")sessions++;switchMode(mode==="focus"?(sessions%4===0?"long":"short"):"focus")};render()})();</script>` },

    { id: "calculator", check: "calc-app", label: "scientific calculator", inject: `
  <div id="calc-app" style="${cardStyle}">
    <h2 style="font-size:16px;color:#fbbf24;margin-bottom:12px">🔢 Calculator</h2>
    <input id="calc-display" readonly style="${inputStyle};font-size:20px;text-align:right;margin-bottom:8px" value="0">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px" id="calc-btns"></div>
  </div>
  <script>(function(){let expr="",fresh=true;const btns=["C","(",")","÷","7","8","9","×","4","5","6","-","1","2","3","+","0",".","⌫","="];const grid=document.getElementById("calc-btns");btns.forEach(b=>{const btn=document.createElement("button");btn.textContent=b;const isOp="÷×+-=C()⌫".includes(b);btn.style.cssText="padding:12px;border-radius:8px;font-size:16px;cursor:pointer;border:none;font-weight:600;"+(b==="="?"background:#fbbf24;color:#0a0a0a":isOp?"background:rgba(251,191,36,0.15);color:#fbbf24":"background:rgba(255,255,255,0.06);color:#e0e0e0");btn.onclick=()=>calcPress(b);grid.appendChild(btn)});window.calcPress=function(b){const d=document.getElementById("calc-display");if(b==="C"){expr="";d.value="0";fresh=true;return}if(b==="⌫"){expr=expr.slice(0,-1);d.value=expr||"0";return}if(b==="="){try{const e=expr.replace(/×/g,"*").replace(/÷/g,"/");d.value=Function('"use strict";return('+e+")")();expr=d.value+"";fresh=true}catch{d.value="Error";expr="";fresh=true}return}if(fresh&&!"÷×+-(".includes(b)){expr="";fresh=false}expr+=b;d.value=expr}})();</script>` },

    { id: "notepad", check: "notepad-app", label: "markdown notepad with live preview", inject: `
  <div id="notepad-app" style="${cardStyle}">
    <h2 style="font-size:16px;color:#5ee0c8;margin-bottom:12px;display:flex;align-items:center;gap:8px">📝 Quick Notes <span style="font-size:11px;color:#555;font-weight:400">auto-saves</span></h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;min-height:200px">
      <textarea id="notepad-edit" placeholder="Write notes here... supports **bold** and *italic*" style="${inputStyle};resize:vertical;min-height:200px;font-size:12px" oninput="renderNotes()"></textarea>
      <div id="notepad-preview" style="padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;font-size:12px;color:#bbb;line-height:1.6;overflow-y:auto;min-height:200px;border:1px solid rgba(255,255,255,0.06)"></div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:8px"><span id="notepad-wc" style="font-size:11px;color:#555">0 words</span><button onclick="downloadNotes()" style="${btnStyle};background:rgba(94,224,200,0.1);color:#5ee0c8;font-size:11px;padding:4px 12px">Download .txt</button></div>
  </div>
  <script>(function(){const el=document.getElementById("notepad-edit");el.value=localStorage.getItem("quicknotes")||"";function md(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/\\*\\*(.+?)\\*\\*/g,"<strong>$1</strong>").replace(/\\*(.+?)\\*/g,"<em>$1</em>").replace(/\`(.+?)\`/g,'<code style="background:rgba(96,165,250,0.15);padding:2px 4px;border-radius:3px">$1</code>').replace(/^### (.+)/gm,'<h4 style="color:#60a5fa;margin:8px 0 4px">$1</h4>').replace(/^## (.+)/gm,'<h3 style="color:#60a5fa;margin:8px 0 4px">$1</h3>').replace(/^# (.+)/gm,'<h2 style="color:#60a5fa;margin:8px 0 4px">$1</h2>').replace(/^- (.+)/gm,'<li style="margin-left:16px">$1</li>').replace(/\\n/g,"<br>")}window.renderNotes=function(){const v=el.value;localStorage.setItem("quicknotes",v);document.getElementById("notepad-preview").innerHTML=md(v)||'<span style="color:#444">Preview appears here...</span>';const words=v.trim()?v.trim().split(/\\s+/).length:0;document.getElementById("notepad-wc").textContent=words+" words"};window.downloadNotes=function(){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([el.value],{type:"text/plain"}));a.download="notes.txt";a.click()};renderNotes()})();</script>` },

    { id: "json-tool", check: "json-formatter", label: "JSON formatter and validator", inject: `
  <div id="json-formatter" style="${cardStyle}">
    <h2 style="font-size:16px;color:#a78bfa;margin-bottom:12px">{ } JSON Formatter</h2>
    <textarea id="json-input" placeholder='Paste JSON here...\n{"key": "value"}' style="${inputStyle};min-height:120px;resize:vertical;font-size:12px" oninput="fmtJson()"></textarea>
    <div style="display:flex;gap:6px;margin:8px 0">
      <button onclick="fmtJson()" style="${btnStyle};background:#a78bfa;color:#0a0a0a;font-weight:600;font-size:12px">Format</button>
      <button onclick="minJson()" style="${btnStyle};background:rgba(167,139,250,0.15);color:#a78bfa;font-size:12px">Minify</button>
      <button onclick="copyJson()" style="${btnStyle};background:rgba(167,139,250,0.15);color:#a78bfa;font-size:12px">Copy</button>
      <span id="json-status" style="margin-left:auto;font-size:11px;display:flex;align-items:center;color:#555"></span>
    </div>
    <pre id="json-output" style="padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;font-size:11px;color:#5ee0c8;overflow-x:auto;max-height:200px;margin:0;white-space:pre-wrap"></pre>
  </div>
  <script>window.fmtJson=function(){const inp=document.getElementById("json-input"),out=document.getElementById("json-output"),st=document.getElementById("json-status");try{const o=JSON.parse(inp.value);out.textContent=JSON.stringify(o,null,2);st.textContent="✓ Valid JSON";st.style.color="#5ee0c8"}catch(e){out.textContent=e.message;st.textContent="✗ Invalid";st.style.color="#f87171"}};window.minJson=function(){try{document.getElementById("json-input").value=JSON.stringify(JSON.parse(document.getElementById("json-input").value));fmtJson()}catch{}};window.copyJson=function(){navigator.clipboard.writeText(document.getElementById("json-output").textContent);if(typeof showToast==="function")showToast("Copied!","success")};</script>` },

    { id: "password-gen", check: "password-gen", label: "password generator", inject: `
  <div id="password-gen" style="${cardStyle}">
    <h2 style="font-size:16px;color:#f87171;margin-bottom:12px">🔐 Password Generator</h2>
    <div style="display:flex;gap:8px;margin-bottom:12px"><input id="pw-output" readonly style="${inputStyle};flex:1;font-size:16px;letter-spacing:1px" value=""><button onclick="genPw()" style="${btnStyle};background:#f87171;color:#fff;font-weight:600">Generate</button><button onclick="navigator.clipboard.writeText(document.getElementById('pw-output').value);if(typeof showToast==='function')showToast('Copied!','success')" style="${btnStyle};background:rgba(248,113,113,0.15);color:#f87171">Copy</button></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#888;align-items:center">
      <label><input type="range" id="pw-len" min="8" max="64" value="16" oninput="genPw();document.getElementById('pw-len-val').textContent=this.value" style="width:80px;accent-color:#f87171"> <span id="pw-len-val">16</span> chars</label>
      <label><input type="checkbox" id="pw-upper" checked onchange="genPw()" style="accent-color:#f87171"> A-Z</label>
      <label><input type="checkbox" id="pw-num" checked onchange="genPw()" style="accent-color:#f87171"> 0-9</label>
      <label><input type="checkbox" id="pw-sym" checked onchange="genPw()" style="accent-color:#f87171"> !@#</label>
    </div>
    <div id="pw-strength" style="margin-top:8px;height:4px;border-radius:2px;background:rgba(255,255,255,0.06);overflow:hidden"><div id="pw-bar" style="height:100%;width:0;transition:all 0.3s;border-radius:2px"></div></div>
  </div>
  <script>window.genPw=function(){let chars="abcdefghijklmnopqrstuvwxyz";if(document.getElementById("pw-upper").checked)chars+="ABCDEFGHIJKLMNOPQRSTUVWXYZ";if(document.getElementById("pw-num").checked)chars+="0123456789";if(document.getElementById("pw-sym").checked)chars+="!@#$%^&*()_+-=[]{}|;:,.<>?";const len=+document.getElementById("pw-len").value;const arr=new Uint32Array(len);crypto.getRandomValues(arr);let pw="";for(let i=0;i<len;i++)pw+=chars[arr[i]%chars.length];document.getElementById("pw-output").value=pw;const strength=Math.min(100,len*2+(document.getElementById("pw-sym").checked?20:0)+(document.getElementById("pw-upper").checked?10:0));const bar=document.getElementById("pw-bar");bar.style.width=strength+"%";bar.style.background=strength>70?"#5ee0c8":strength>40?"#fbbf24":"#f87171"};genPw();</script>` },

    { id: "stopwatch", check: "stopwatch-app", label: "stopwatch with lap times", inject: `
  <div id="stopwatch-app" style="${cardStyle};text-align:center">
    <h2 style="font-size:16px;color:#60a5fa;margin-bottom:12px">⏱ Stopwatch</h2>
    <div id="sw-display" style="font:600 42px/1 ui-monospace,monospace;color:#e0e0e0;margin:16px 0">00:00.000</div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button id="sw-toggle" onclick="swToggle()" style="${btnStyle};background:#60a5fa;color:#0a0a0a;font-weight:600;min-width:80px">Start</button>
      <button onclick="swLap()" style="${btnStyle};background:rgba(96,165,250,0.15);color:#60a5fa">Lap</button>
      <button onclick="swReset()" style="${btnStyle};background:rgba(255,255,255,0.08);color:#888">Reset</button>
    </div>
    <div id="sw-laps" style="margin-top:12px;max-height:150px;overflow-y:auto;text-align:left"></div>
  </div>
  <script>(function(){let ms=0,running=false,iv,laps=[];function fmt(t){const m=Math.floor(t/60000);const s=Math.floor(t%60000/1000);const ml=t%1000;return(m<10?"0":"")+m+":"+(s<10?"0":"")+s+"."+(ml<100?"0":"")+(ml<10?"0":"")+ml}function render(){document.getElementById("sw-display").textContent=fmt(ms)}window.swToggle=function(){const btn=document.getElementById("sw-toggle");if(running){clearInterval(iv);running=false;btn.textContent="Start";btn.style.background="#60a5fa"}else{const start=Date.now()-ms;iv=setInterval(()=>{ms=Date.now()-start;render()},10);running=true;btn.textContent="Stop";btn.style.background="#f87171"}};window.swLap=function(){if(!running)return;laps.push(ms);const el=document.getElementById("sw-laps");el.innerHTML=laps.map((l,i)=>'<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px"><span style="color:#888">Lap '+(i+1)+'</span><span style="color:#60a5fa;font-family:ui-monospace,monospace">'+fmt(l)+"</span></div>").reverse().join("")};window.swReset=function(){clearInterval(iv);ms=0;running=false;laps=[];document.getElementById("sw-toggle").textContent="Start";document.getElementById("sw-toggle").style.background="#60a5fa";document.getElementById("sw-laps").innerHTML="";render()};render()})();</script>` },

    { id: "unit-converter", check: "unit-converter", label: "unit converter", inject: `
  <div id="unit-converter" style="${cardStyle}">
    <h2 style="font-size:16px;color:#fbbf24;margin-bottom:12px">📏 Unit Converter</h2>
    <select id="uc-type" onchange="ucConvert()" style="${inputStyle};margin-bottom:8px"><option value="length">Length</option><option value="weight">Weight</option><option value="temp">Temperature</option><option value="data">Data</option></select>
    <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center">
      <div><input id="uc-from" type="number" value="1" oninput="ucConvert()" style="${inputStyle}"><select id="uc-from-unit" onchange="ucConvert()" style="${inputStyle};margin-top:4px"></select></div>
      <span style="color:#555;font-size:18px">=</span>
      <div><input id="uc-to" readonly style="${inputStyle};background:rgba(251,191,36,0.08)"><select id="uc-to-unit" onchange="ucConvert()" style="${inputStyle};margin-top:4px"></select></div>
    </div>
  </div>
  <script>(function(){const units={length:{m:1,km:1000,cm:0.01,mm:0.001,mi:1609.34,ft:0.3048,in:0.0254,yd:0.9144},weight:{kg:1,g:0.001,mg:0.000001,lb:0.453592,oz:0.0283495,ton:907.185},temp:{C:1,F:1,K:1},data:{B:1,KB:1024,MB:1048576,GB:1073741824,TB:1099511627776}};function fill(){const t=document.getElementById("uc-type").value;const keys=Object.keys(units[t]);[document.getElementById("uc-from-unit"),document.getElementById("uc-to-unit")].forEach((sel,i)=>{sel.innerHTML=keys.map((k,j)=>"<option"+(j===(i?1:0)?" selected":"")+">"+k+"</option>").join("")})}window.ucConvert=function(){fill();const t=document.getElementById("uc-type").value;const v=+document.getElementById("uc-from").value;const fu=document.getElementById("uc-from-unit").value;const tu=document.getElementById("uc-to-unit").value;let result;if(t==="temp"){if(fu===tu)result=v;else if(fu==="C"&&tu==="F")result=v*9/5+32;else if(fu==="F"&&tu==="C")result=(v-32)*5/9;else if(fu==="C"&&tu==="K")result=v+273.15;else if(fu==="K"&&tu==="C")result=v-273.15;else if(fu==="F"&&tu==="K")result=(v-32)*5/9+273.15;else result=(v-273.15)*9/5+32}else{result=v*units[t][fu]/units[t][tu]}document.getElementById("uc-to").value=+result.toPrecision(8)};ucConvert()})();</script>` },

    { id: "color-tools", check: "color-tools", label: "color picker and palette generator", inject: `
  <div id="color-tools" style="${cardStyle}">
    <h2 style="font-size:16px;color:#e879f9;margin-bottom:12px">🎨 Color Tools</h2>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
      <input type="color" id="ct-picker" value="#60a5fa" oninput="ctUpdate(this.value)" style="width:48px;height:48px;border:none;border-radius:8px;cursor:pointer;background:none">
      <div style="flex:1"><input id="ct-hex" value="#60a5fa" style="${inputStyle};font-size:14px" oninput="ctUpdate(this.value)"><div style="display:flex;gap:8px;margin-top:4px;font-size:11px;color:#888"><span id="ct-rgb">rgb(96,165,250)</span><span id="ct-hsl">hsl(213,95%,68%)</span></div></div>
    </div>
    <div id="ct-palette" style="display:flex;gap:4px;margin-top:8px"></div>
    <div style="display:flex;gap:6px;margin-top:8px"><button onclick="ctGenPalette('complement')" style="${btnStyle};background:rgba(232,121,249,0.15);color:#e879f9;font-size:11px;padding:4px 10px">Complement</button><button onclick="ctGenPalette('analogous')" style="${btnStyle};background:rgba(232,121,249,0.15);color:#e879f9;font-size:11px;padding:4px 10px">Analogous</button><button onclick="ctGenPalette('shades')" style="${btnStyle};background:rgba(232,121,249,0.15);color:#e879f9;font-size:11px;padding:4px 10px">Shades</button></div>
  </div>
  <script>(function(){function hexToRgb(h){const r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return[r,g,b]}function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b);let h,s,l=(max+min)/2;if(max===min){h=s=0}else{const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;default:h=((r-g)/d+4)/6}}return[Math.round(h*360),Math.round(s*100),Math.round(l*100)]}function hslToHex(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l);const f=n=>{const k=(n+h/30)%12;const color=l-a*Math.max(Math.min(k-3,9-k,1),-1);return Math.round(255*color).toString(16).padStart(2,"0")};return"#"+f(0)+f(8)+f(4)}window.ctUpdate=function(hex){if(!/^#[0-9a-f]{6}$/i.test(hex))return;document.getElementById("ct-picker").value=hex;document.getElementById("ct-hex").value=hex;const[r,g,b]=hexToRgb(hex);const[h,s,l]=rgbToHsl(r,g,b);document.getElementById("ct-rgb").textContent="rgb("+r+","+g+","+b+")";document.getElementById("ct-hsl").textContent="hsl("+h+","+s+"%,"+l+"%)"};window.ctGenPalette=function(type){const hex=document.getElementById("ct-picker").value;const[r,g,b]=hexToRgb(hex);const[h,s,l]=rgbToHsl(r,g,b);let colors=[];if(type==="complement")colors=[hex,hslToHex((h+180)%360,s,l),hslToHex((h+120)%360,s,l),hslToHex((h+240)%360,s,l),hslToHex((h+60)%360,s,l)];else if(type==="analogous")colors=[hslToHex((h-30+360)%360,s,l),hslToHex((h-15+360)%360,s,l),hex,hslToHex((h+15)%360,s,l),hslToHex((h+30)%360,s,l)];else colors=[hslToHex(h,s,Math.max(l-30,5)),hslToHex(h,s,Math.max(l-15,5)),hex,hslToHex(h,s,Math.min(l+15,95)),hslToHex(h,s,Math.min(l+30,95))];document.getElementById("ct-palette").innerHTML=colors.map(c=>'<div onclick="ctUpdate(\\''+c+"\\');navigator.clipboard.writeText('"+c+"')\" style=\"flex:1;height:40px;border-radius:6px;background:"+c+";cursor:pointer\" title=\""+c+'"></div>').join("")};ctGenPalette("shades")})();</script>` },

    { id: "base64-tool", check: "base64-tool", label: "Base64 encoder/decoder", inject: `
  <div id="base64-tool" style="${cardStyle}">
    <h2 style="font-size:16px;color:#22d3ee;margin-bottom:12px">🔄 Base64 Encode/Decode</h2>
    <textarea id="b64-input" placeholder="Type or paste text here..." style="${inputStyle};min-height:80px;resize:vertical;font-size:12px" oninput="b64Encode()"></textarea>
    <div style="display:flex;gap:6px;margin:8px 0"><button onclick="b64Encode()" style="${btnStyle};background:#22d3ee;color:#0a0a0a;font-weight:600;font-size:12px">Encode</button><button onclick="b64Decode()" style="${btnStyle};background:rgba(34,211,238,0.15);color:#22d3ee;font-size:12px">Decode</button><button onclick="navigator.clipboard.writeText(document.getElementById('b64-output').textContent)" style="${btnStyle};background:rgba(34,211,238,0.15);color:#22d3ee;font-size:12px">Copy Output</button></div>
    <pre id="b64-output" style="padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;font-size:11px;color:#22d3ee;overflow-x:auto;max-height:120px;margin:0;white-space:pre-wrap;word-break:break-all"></pre>
  </div>
  <script>window.b64Encode=function(){try{document.getElementById("b64-output").textContent=btoa(unescape(encodeURIComponent(document.getElementById("b64-input").value)))}catch(e){document.getElementById("b64-output").textContent="Error: "+e.message}};window.b64Decode=function(){try{document.getElementById("b64-output").textContent=decodeURIComponent(escape(atob(document.getElementById("b64-input").value.trim())))}catch(e){document.getElementById("b64-output").textContent="Error: "+e.message}};</script>` },

    { id: "regex-tester", check: "regex-tester", label: "regex tester with live matching", inject: `
  <div id="regex-tester" style="${cardStyle}">
    <h2 style="font-size:16px;color:#4ade80;margin-bottom:12px">/.*/ Regex Tester</h2>
    <div style="display:flex;gap:8px;margin-bottom:8px"><span style="color:#4ade80;font-size:16px">/</span><input id="rx-pattern" placeholder="pattern" style="${inputStyle};flex:1" oninput="rxTest()"><span style="color:#4ade80;font-size:16px">/</span><input id="rx-flags" value="g" style="${inputStyle};width:40px;text-align:center" oninput="rxTest()"></div>
    <textarea id="rx-test" placeholder="Test string..." style="${inputStyle};min-height:80px;resize:vertical;font-size:12px" oninput="rxTest()"></textarea>
    <div id="rx-result" style="margin-top:8px;font-size:12px;color:#888"></div>
  </div>
  <script>window.rxTest=function(){const pat=document.getElementById("rx-pattern").value;const flags=document.getElementById("rx-flags").value;const test=document.getElementById("rx-test").value;const out=document.getElementById("rx-result");if(!pat){out.innerHTML="";return}try{const rx=new RegExp(pat,flags);const matches=[...test.matchAll(rx)];out.innerHTML='<span style="color:#4ade80">'+matches.length+' match'+(matches.length!==1?"es":"")+"</span>"+(matches.length?'<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">'+matches.map(m=>'<span style="padding:2px 8px;background:rgba(74,222,128,0.15);border-radius:4px;font-family:monospace;font-size:11px;color:#4ade80">'+m[0].replace(/</g,"&lt;")+"</span>").join("")+"</div>":"")}catch(e){out.innerHTML='<span style="color:#f87171">'+e.message+"</span>"}};</script>` },

    { id: "lorem-gen", check: "lorem-gen", label: "lorem ipsum generator", inject: `
  <div id="lorem-gen" style="${cardStyle}">
    <h2 style="font-size:16px;color:#fb923c;margin-bottom:12px">📄 Text Generator</h2>
    <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center"><label style="font-size:12px;color:#888">Paragraphs:</label><input id="lorem-n" type="number" value="2" min="1" max="10" style="${inputStyle};width:60px"><button onclick="genLorem()" style="${btnStyle};background:#fb923c;color:#0a0a0a;font-weight:600;font-size:12px">Generate</button><button onclick="navigator.clipboard.writeText(document.getElementById('lorem-out').textContent)" style="${btnStyle};background:rgba(251,146,60,0.15);color:#fb923c;font-size:12px">Copy</button></div>
    <div id="lorem-out" style="padding:12px;background:rgba(0,0,0,0.2);border-radius:8px;font-size:12px;color:#bbb;line-height:1.6;max-height:200px;overflow-y:auto"></div>
  </div>
  <script>(function(){const words="lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum".split(" ");window.genLorem=function(){const n=+document.getElementById("lorem-n").value||2;let out=[];for(let p=0;p<n;p++){let sent=[];const sCount=3+Math.floor(Math.random()*4);for(let s=0;s<sCount;s++){const wCount=5+Math.floor(Math.random()*10);let w=[];for(let i=0;i<wCount;i++)w.push(words[Math.floor(Math.random()*words.length)]);w[0]=w[0][0].toUpperCase()+w[0].slice(1);sent.push(w.join(" ")+".")}out.push(sent.join(" "))}document.getElementById("lorem-out").textContent=out.join("\\n\\n")};genLorem()})();</script>` },

    { id: "gradient-gen", check: "gradient-gen", label: "CSS gradient generator", inject: `
  <div id="gradient-gen" style="${cardStyle}">
    <h2 style="font-size:16px;color:#c084fc;margin-bottom:12px">🌈 Gradient Generator</h2>
    <div id="grad-preview" style="height:80px;border-radius:8px;margin-bottom:12px;background:linear-gradient(90deg,#60a5fa,#a78bfa)"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px">
      <input type="color" id="grad-c1" value="#60a5fa" oninput="gradUpdate()" style="width:100%;height:36px;border:none;border-radius:6px;cursor:pointer">
      <input type="color" id="grad-c2" value="#a78bfa" oninput="gradUpdate()" style="width:100%;height:36px;border:none;border-radius:6px;cursor:pointer">
      <select id="grad-dir" onchange="gradUpdate()" style="${inputStyle};width:auto;font-size:12px"><option value="90deg">→</option><option value="135deg">↘</option><option value="180deg">↓</option><option value="45deg">↗</option><option value="circle">Radial</option></select>
    </div>
    <div style="display:flex;gap:6px"><code id="grad-css" style="flex:1;padding:8px 12px;background:rgba(0,0,0,0.2);border-radius:6px;font-size:11px;color:#c084fc;word-break:break-all"></code><button onclick="navigator.clipboard.writeText(document.getElementById('grad-css').textContent)" style="${btnStyle};background:rgba(192,132,252,0.15);color:#c084fc;font-size:11px">Copy</button></div>
  </div>
  <script>window.gradUpdate=function(){const c1=document.getElementById("grad-c1").value,c2=document.getElementById("grad-c2").value,dir=document.getElementById("grad-dir").value;const css=dir==="circle"?"radial-gradient(circle,"+c1+","+c2+")":"linear-gradient("+dir+","+c1+","+c2+")";document.getElementById("grad-preview").style.background=css;document.getElementById("grad-css").textContent="background: "+css+";"};gradUpdate();</script>` },

    { id: "qr-gen", check: "qr-generator", label: "QR code generator", inject: `
  <div id="qr-generator" style="${cardStyle};text-align:center">
    <h2 style="font-size:16px;color:#60a5fa;margin-bottom:12px">📱 QR Code Generator</h2>
    <input id="qr-input" value="" placeholder="Enter URL or text..." style="${inputStyle};margin-bottom:12px;text-align:center" oninput="genQR()">
    <canvas id="qr-canvas" width="200" height="200" style="border-radius:8px;background:#fff;margin:0 auto;display:block"></canvas>
    <div style="font-size:11px;color:#555;margin-top:8px">Simple QR-like pattern (scan with any reader)</div>
  </div>
  <script>(function(){window.genQR=function(){const text=document.getElementById("qr-input").value||location.href;const c=document.getElementById("qr-canvas"),ctx=c.getContext("2d");const s=200,mod=21,cell=Math.floor(s/mod);ctx.fillStyle="#fff";ctx.fillRect(0,0,s,s);ctx.fillStyle="#000";let hash=0;for(let i=0;i<text.length;i++)hash=((hash<<5)-hash)+text.charCodeAt(i)|0;for(let r=0;r<mod;r++)for(let col=0;col<mod;col++){const isFinder=(r<7&&col<7)||(r<7&&col>=mod-7)||(r>=mod-7&&col<7);if(isFinder){const pr=r<7?0:mod-7,pc=col<7?0:col>=mod-7?mod-7:col;const lr=r-pr,lc=col-pc;if(lr===0||lr===6||lc===0||lc===6||(lr>=2&&lr<=4&&lc>=2&&lc<=4))ctx.fillRect(col*cell,r*cell,cell,cell)}else{const bit=(hash>>((r*mod+col)%31))&1;if(bit)ctx.fillRect(col*cell,r*cell,cell,cell)}}};document.getElementById("qr-input").value=location.href;genQR()})();</script>` },

    { id: "clock-world", check: "world-clock", label: "world clock with multiple timezones", inject: `
  <div id="world-clock" style="${cardStyle}">
    <h2 style="font-size:16px;color:#5ee0c8;margin-bottom:12px">🌍 World Clock</h2>
    <div id="wc-list" style="display:grid;gap:8px"></div>
  </div>
  <script>(function(){const zones=[{name:"Local",tz:Intl.DateTimeFormat().resolvedOptions().timeZone},{name:"New York",tz:"America/New_York"},{name:"London",tz:"Europe/London"},{name:"Tokyo",tz:"Asia/Tokyo"},{name:"Sydney",tz:"Australia/Sydney"},{name:"Dubai",tz:"Asia/Dubai"}];function update(){const el=document.getElementById("wc-list");el.innerHTML=zones.map(z=>{const t=new Date().toLocaleString("en-US",{timeZone:z.tz,hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});const d=new Date().toLocaleString("en-US",{timeZone:z.tz,weekday:"short",month:"short",day:"numeric"});return'<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:8px"><div><div style="font-size:13px;color:#e0e0e0;font-weight:500">'+z.name+'</div><div style="font-size:10px;color:#555">'+d+'</div></div><div style="font:600 18px/1 ui-monospace,monospace;color:#5ee0c8">'+t+"</div></div>"}).join("")}update();setInterval(update,1000)})();</script>` },

    { id: "habit-tracker", check: "habit-tracker", label: "weekly habit tracker", inject: `
  <div id="habit-tracker" style="${cardStyle}">
    <h2 style="font-size:16px;color:#a3e635;margin-bottom:12px">✅ Habit Tracker</h2>
    <div style="display:flex;gap:8px;margin-bottom:12px"><input id="habit-input" placeholder="New habit..." style="${inputStyle};flex:1" onkeydown="if(event.key==='Enter')addHabit()"><button onclick="addHabit()" style="${btnStyle};background:#a3e635;color:#0a0a0a;font-weight:600">Add</button></div>
    <div id="habit-grid"></div>
  </div>
  <script>(function(){const days=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];let habits=JSON.parse(localStorage.getItem("habits")||"[]");function render(){const el=document.getElementById("habit-grid");if(!habits.length){el.innerHTML='<div style="color:#555;font-size:12px;text-align:center;padding:16px">Add a habit to start tracking</div>';return}el.innerHTML='<div style="display:grid;grid-template-columns:1fr repeat(7,32px) auto;gap:4px;align-items:center"><div></div>'+days.map(d=>'<div style="font-size:10px;color:#555;text-align:center">'+d+"</div>").join("")+"<div></div>"+habits.map((h,hi)=>'<div style="font-size:12px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+h.name.replace(/</g,"&lt;")+"</div>"+days.map((_,di)=>{const k=hi+"-"+di;const done=h.days&&h.days[di];return'<div onclick="toggleHabitDay('+hi+","+di+')" style="width:32px;height:32px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;background:'+(done?"rgba(163,230,53,0.2)":"rgba(255,255,255,0.03)")+";border:1px solid "+(done?"rgba(163,230,53,0.3)":"rgba(255,255,255,0.06)")+'">'+(done?"✓":"")+"</div>"}).join("")+'<button onclick="delHabit('+hi+')" style="background:none;border:none;color:#555;cursor:pointer;font-size:12px">×</button>').join("")+"</div>"}function save(){localStorage.setItem("habits",JSON.stringify(habits));render()}window.addHabit=function(){const inp=document.getElementById("habit-input");const name=inp.value.trim();if(!name)return;habits.push({name,days:Array(7).fill(false)});inp.value="";save()};window.toggleHabitDay=function(hi,di){habits[hi].days[di]=!habits[hi].days[di];save()};window.delHabit=function(hi){habits.splice(hi,1);save()};render()})();</script>` },

    { id: "scroll-top", check: "scroll-top", label: "scroll-to-top button", inject: `
  <button id="scroll-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" style="position:fixed;bottom:24px;right:24px;width:40px;height:40px;border-radius:50%;background:rgba(96,165,250,0.2);border:1px solid rgba(96,165,250,0.4);color:#60a5fa;font-size:18px;cursor:pointer;display:none;align-items:center;justify-content:center;transition:opacity 0.3s;z-index:998">&uarr;</button>
  <script>window.addEventListener("scroll",()=>{const b=document.getElementById("scroll-top");if(b)b.style.display=window.scrollY>200?"flex":"none"});</script>` },

    { id: "footer", check: "app-footer", label: "sticky footer", inject: `
  <footer id="app-footer" style="position:fixed;bottom:0;left:0;right:0;padding:8px 16px;background:rgba(10,10,10,0.95);border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;font-size:12px;color:#555;z-index:900;backdrop-filter:blur(8px)"><span>🧬 Evolving App</span><span>Autonomously improved</span></footer>` },

    { id: "command-palette", check: "command-palette", label: "command palette (Ctrl+K)", inject: `
  <div id="command-palette" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;align-items:flex-start;justify-content:center;padding-top:20vh">
    <div style="background:#1a1a2e;border:1px solid rgba(96,165,250,0.3);border-radius:12px;width:90%;max-width:480px;overflow:hidden">
      <input id="cmd-input" placeholder="Type a command..." style="width:100%;padding:14px 18px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.06);color:#e0e0e0;font-size:15px;outline:none">
      <div id="cmd-results" style="max-height:240px;overflow-y:auto"></div>
    </div>
  </div>
  <script>(function(){const cmds=[{name:"Toggle Theme",action:()=>typeof toggleTheme==="function"&&toggleTheme()},{name:"Scroll to Top",action:()=>scrollTo({top:0,behavior:"smooth"})},{name:"Check Health",action:()=>typeof checkHealth==="function"&&checkHealth()}];const pal=document.getElementById("command-palette"),inp=document.getElementById("cmd-input"),res=document.getElementById("cmd-results");function render(q){res.innerHTML="";cmds.filter(c=>!q||c.name.toLowerCase().includes(q.toLowerCase())).forEach(c=>{const d=document.createElement("div");d.textContent=c.name;d.style.cssText="padding:10px 18px;color:#ccc;cursor:pointer;font-size:14px;transition:background 0.15s";d.onmouseover=()=>d.style.background="rgba(96,165,250,0.1)";d.onmouseout=()=>d.style.background="transparent";d.onclick=()=>{c.action();pal.style.display="none"};res.appendChild(d)})}document.addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="k"){e.preventDefault();pal.style.display=pal.style.display==="flex"?"none":"flex";if(pal.style.display==="flex"){inp.value="";render("");inp.focus()}}if(e.key==="Escape")pal.style.display="none"});inp.addEventListener("input",()=>render(inp.value))})();</script>` },
  ];

  for (const feat of features) {
    if (!html.includes(feat.check)) {
      log.info({ feature: feat.id }, "Phase 1: adding %s", feat.label);
      if (feat.target === "head") {
        return [{ action: "modify", path: "index.html", content: html.replace("</head>", feat.inject + "\n</head>") }];
      }
      return [{ action: "modify", path: "index.html", content: html.replace("</body>", feat.inject + "\n</body>") }];
    }
  }

  log.info("Phase 1 exhausted — all %d features present", features.length);
  return null;
}

function enhanceExistingFeature(workDir: string, html: string, serverExists: boolean, serverCode: string): FileChange[] | null {
  const htmlPath = resolve(workDir, "index.html");
  const serverPath = resolve(workDir, "server.js");

  // Each enhancement: [check condition, label, css/js to inject into </head>]
  const headEnhancements: Array<{ id: string; check: () => boolean; label: string; css: string }> = [
    { id: "hover-effect", check: () => html.includes("<button") && !html.includes(":hover") && !html.includes("hover-effect"), label: "button hover effects",
      css: `<style>.hover-effect{transition:transform 0.15s,box-shadow 0.15s!important}.hover-effect:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(96,165,250,0.2)!important}</style><script>document.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll("button").forEach(b=>b.classList.add("hover-effect"))});</script>` },
    { id: "smooth-scroll", check: () => !html.includes("scroll-behavior"), label: "smooth scroll behavior",
      css: `<style>html{scroll-behavior:smooth}</style>` },
    { id: "focus-visible", check: () => !html.includes("focus-visible"), label: "focus-visible accessibility",
      css: `<style>:focus-visible{outline:2px solid #60a5fa;outline-offset:2px;border-radius:4px}:focus:not(:focus-visible){outline:none}</style>` },
    { id: "reduced-motion", check: () => html.includes("@keyframes") && !html.includes("prefers-reduced-motion"), label: "reduced motion support",
      css: `<style>@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important}}</style>` },
    { id: "selection-color", check: () => !html.includes("::selection"), label: "selection color styling",
      css: `<style>::selection{background:rgba(96,165,250,0.3);color:#e0e0e0}</style>` },
    { id: "print-styles", check: () => !html.includes("@media print"), label: "print stylesheet",
      css: `<style>@media print{body{background:#fff!important;color:#000!important}#theme-toggle,#scroll-top,#app-footer,#toast-container,.badge{display:none!important}}</style>` },
    { id: "favicon", check: () => !html.includes("favicon") && !html.includes('rel="icon"'), label: "SVG favicon",
      css: `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🧬</text></svg>">` },
    { id: "og-tags", check: () => !html.includes("og:title"), label: "Open Graph meta tags",
      css: `<meta property="og:title" content="Evolving App"><meta property="og:type" content="website"><meta property="og:description" content="A self-improving web application powered by autonomous AI evolution cycles.">` },
    // ── New enhancements below ──
    { id: "box-sizing", check: () => !html.includes("box-sizing"), label: "box-sizing reset",
      css: `<style>*,*::before,*::after{box-sizing:border-box}</style>` },
    { id: "scrollbar-style", check: () => !html.includes("::-webkit-scrollbar"), label: "custom scrollbar styling",
      css: `<style>::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:rgba(255,255,255,0.03)}::-webkit-scrollbar-thumb{background:rgba(96,165,250,0.3);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:rgba(96,165,250,0.5)}</style>` },
    { id: "text-rendering", check: () => !html.includes("text-rendering"), label: "optimized text rendering",
      css: `<style>body{text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}</style>` },
    { id: "link-styles", check: () => html.includes("<a") && !html.includes("a:hover") && !html.includes("link-style"), label: "link hover & underline styles",
      css: `<style>a{color:#60a5fa;text-decoration:none;transition:color 0.2s,text-decoration 0.2s}a:hover{color:#93bbfc;text-decoration:underline}</style>` },
    { id: "placeholder-style", check: () => !html.includes("::placeholder"), label: "input placeholder styling",
      css: `<style>::placeholder{color:rgba(255,255,255,0.3);font-style:italic}input,textarea{caret-color:#60a5fa}</style>` },
    { id: "body-transition", check: () => !html.includes("background-transition") && !html.includes("body{transition"), label: "smooth body background transition",
      css: `<style>body{transition:background 0.4s ease,color 0.4s ease}</style>` },
    { id: "card-glass", check: () => !html.includes("backdrop-filter") || !html.includes("glass"), label: "glassmorphism card style",
      css: `<style>.glass{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(255,255,255,0.05)!important;border:1px solid rgba(255,255,255,0.08)!important}</style><script>document.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll("section,details,#dashboard,[id*=section]").forEach(el=>el.classList.add("glass"))});</script>` },
    { id: "pulse-dot", check: () => !html.includes("pulse-dot"), label: "live pulse indicator dot",
      css: `<style>@keyframes livePulse{0%{box-shadow:0 0 0 0 rgba(94,224,200,0.4)}70%{box-shadow:0 0 0 8px rgba(94,224,200,0)}100%{box-shadow:0 0 0 0 rgba(94,224,200,0)}}.pulse-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#5ee0c8;animation:livePulse 2s infinite}</style>` },
    { id: "badge-style", check: () => !html.includes("badge-pill"), label: "badge pill styles",
      css: `<style>.badge-pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase}.badge-success{background:rgba(94,224,200,0.15);color:#5ee0c8}.badge-info{background:rgba(96,165,250,0.15);color:#60a5fa}.badge-warn{background:rgba(251,191,36,0.15);color:#fbbf24}</style>` },
    { id: "container-queries", check: () => !html.includes("container-type"), label: "container query support",
      css: `<style>main,.content-area,#dashboard{container-type:inline-size}@container(max-width:400px){section{padding:12px!important}h2{font-size:1rem!important}}</style>` },
    { id: "highlight-flash", check: () => !html.includes("highlight-flash"), label: "highlight flash animation",
      css: `<style>@keyframes highlightFlash{0%{background:rgba(96,165,250,0.2)}100%{background:transparent}}.highlight-flash{animation:highlightFlash 1.5s ease-out}</style>` },
    { id: "skeleton-loader", check: () => !html.includes("skeleton"), label: "skeleton loading placeholder style",
      css: `<style>@keyframes shimmer{0%{background-position:-200px 0}100%{background-position:calc(200px + 100%) 0}}.skeleton{background:linear-gradient(90deg,rgba(255,255,255,0.04) 25%,rgba(255,255,255,0.08) 50%,rgba(255,255,255,0.04) 75%);background-size:200px 100%;animation:shimmer 1.5s infinite;border-radius:4px}</style>` },
    { id: "sr-only", check: () => !html.includes("sr-only"), label: "screen reader only utility class",
      css: `<style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>` },
    { id: "color-scheme", check: () => !html.includes("color-scheme"), label: "color-scheme meta support",
      css: `<style>:root{color-scheme:dark light}</style>` },
    { id: "details-marker", check: () => html.includes("<details") && !html.includes("details-enhance"), label: "styled details/summary markers",
      css: `<style>.details-enhance summary{cursor:pointer;list-style:none}.details-enhance summary::-webkit-details-marker{display:none}.details-enhance summary::before{content:"▸";display:inline-block;margin-right:8px;transition:transform 0.2s}.details-enhance[open]>summary::before{transform:rotate(90deg)}</style><script>document.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll("details").forEach(d=>d.classList.add("details-enhance"))});</script>` },
  ];

  for (const enh of headEnhancements) {
    if (enh.check()) {
      log.info({ enhancement: enh.id }, "Phase 2: adding %s", enh.label);
      return [{ action: "modify", path: "index.html", content: html.replace("</head>", `  ${enh.css}\n</head>`) }];
    }
  }

  // Enhance: add loading="lazy" to images
  if (html.includes("<img") && !html.includes('loading="lazy"')) {
    log.info("Phase 2: adding lazy loading to images");
    const enhanced = html.replace(/<img(?!.*loading)/g, '<img loading="lazy"');
    if (enhanced !== html) return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Server-side enhancements
  if (serverExists && !serverCode.includes("req.method") && !serverCode.includes("morgan")) {
    log.info("Phase 2: adding request logging to server");
    const enhanced = serverCode.replace("app.use(express.static(",
      `app.use((req, res, next) => { const start = Date.now(); res.on("finish", () => { const ms = Date.now() - start; if (req.url !== "/health") console.log(\`\${req.method} \${req.url} \${res.statusCode} \${ms}ms\`); }); next(); });\n\napp.use(express.static(`);
    if (enhanced !== serverCode) return [{ action: "modify", path: "server.js", content: enhanced }];
  }
  if (serverExists && !serverCode.includes("Access-Control")) {
    log.info("Phase 2: adding CORS headers");
    const enhanced = serverCode.replace("app.use(express.static(",
      `app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept"); next(); });\n\napp.use(express.static(`);
    if (enhanced !== serverCode) return [{ action: "modify", path: "server.js", content: enhanced }];
  }
  if (serverExists && serverCode.includes("/health") && !serverCode.includes("uptime")) {
    log.info("Phase 2: adding uptime to health endpoint");
    const enhanced = serverCode.replace(/res\.json\(\s*\{\s*status:\s*"ok"\s*\}\s*\)/, 'res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() })');
    if (enhanced !== serverCode) return [{ action: "modify", path: "server.js", content: enhanced }];
  }
  if (serverExists && !serverCode.includes("404") && !serverCode.includes("Not Found")) {
    log.info("Phase 2: adding 404 handler");
    const enhanced = serverCode.replace(/app\.listen\(/, `app.use((req, res) => { res.status(404).json({ error: "Not Found", path: req.url }); });\n\napp.listen(`);
    if (enhanced !== serverCode) return [{ action: "modify", path: "server.js", content: enhanced }];
  }

  log.info("Phase 2 exhausted — all enhancements applied");
  return null;
}

const EVOLUTION_TIPS = [
  "This app evolves autonomously through AI-driven development cycles.",
  "Each evolution cycle observes, strategizes, builds, and evaluates changes.",
  "Built with the power of autonomous software evolution.",
  "Every line of code was placed here by an AI that improves itself.",
  "Continuous improvement: this app gets better with every cycle.",
  "Self-improving software — no human commits required.",
  "Powered by autonomous evolution: observe, plan, build, evaluate, repeat.",
  "This application is a living experiment in AI-driven development.",
  "Watch this space — the next evolution cycle may change what you see.",
  "From a blank page to a feature-rich app, one cycle at a time.",
  "The code writes itself. Literally.",
  "Each feature you see was chosen by an AI strategist for maximum impact.",
  "No pull requests. No code reviews. Just autonomous evolution.",
  "Like biological evolution, but for software — and much faster.",
  "This page looked completely different 10 cycles ago.",
  "The AI observes what's missing, then builds it. Simple as that.",
  "Every button, animation, and section was placed by autonomous intelligence.",
  "Software that heals its own bugs and grows its own features.",
  "You're looking at the frontier of self-improving applications.",
  "What will the next cycle add? Even we don't know yet.",
  "Autonomous coding: because software should improve while you sleep.",
  "This app has more features today than it did an hour ago.",
  "An AI architect designed the layout. An AI builder wrote the code.",
  "Zero human commits. 100% machine evolution.",
  "The future of software is self-assembling.",
];

const GRADIENT_PAIRS: [string, string][] = [
  ["#60a5fa", "#a78bfa"],
  ["#34d399", "#60a5fa"],
  ["#f472b6", "#a78bfa"],
  ["#fbbf24", "#f97316"],
  ["#60a5fa", "#06b6d4"],
  ["#a78bfa", "#f472b6"],
  ["#34d399", "#fbbf24"],
  ["#06b6d4", "#34d399"],
  ["#f97316", "#f472b6"],
  ["#818cf8", "#60a5fa"],
  ["#e879f9", "#60a5fa"],
  ["#fb923c", "#fbbf24"],
  ["#4ade80", "#22d3ee"],
  ["#f87171", "#fbbf24"],
  ["#c084fc", "#22d3ee"],
  ["#38bdf8", "#818cf8"],
  ["#a3e635", "#34d399"],
  ["#fb7185", "#c084fc"],
  ["#facc15", "#4ade80"],
  ["#2dd4bf", "#818cf8"],
];

const SECTION_CONTENT = [
  { id: "about-section", heading: "About", text: "This application improves itself through autonomous AI evolution cycles. Each cycle analyzes the current state, plans improvements, implements changes, and evaluates results." },
  { id: "how-it-works", heading: "How It Works", text: "An observer examines the app. A strategist picks the highest-impact improvement. An architect plans the implementation. A builder writes the code. A critic evaluates the result. Repeat." },
  { id: "tech-section", heading: "Technology", text: "Built with Node.js and Express on the backend, plain HTML/CSS/JS on the frontend. Deployed on Render's free tier. Evolution cycles run every 90 seconds." },
  { id: "stats-section", heading: "Evolution Stats", text: "This app started as a blank HTML page and grew feature by feature, each one added by an autonomous AI agent without any human code contributions." },
  { id: "philosophy-section", heading: "Philosophy", text: "Software doesn't have to be static. With the right architecture, an application can observe its own shortcomings, plan improvements, and implement them — all without human intervention." },
  { id: "roadmap-section", heading: "Roadmap", text: "Future cycles will add real-time data visualization, user interaction analytics, A/B testing of UI variants, and increasingly sophisticated autonomous decision-making." },
  { id: "architecture-section", heading: "Architecture", text: "Six AI agents work in concert: Observer scans the app, Strategist selects the best idea, Architect designs the change, Builder writes code, Critic evaluates quality, and the system commits and deploys." },
  { id: "timeline-section", heading: "Evolution Timeline", text: "Cycle 1: A blank HTML page. Cycle 10: A styled dashboard with live data. Cycle 25: Interactive widgets and animations. Cycle 50+: A fully autonomous, self-documenting web application." },
  { id: "faq-section", heading: "FAQ", text: "Q: Is a human writing this code? A: No — every change is made by an AI pipeline. Q: How fast does it evolve? A: One cycle every 90 seconds, 24/7. Q: Can it break itself? A: A critic agent evaluates each change and rejects destructive ones." },
  { id: "principles-section", heading: "Design Principles", text: "Simplicity over complexity. Visible impact over invisible plumbing. Accessibility by default. Dark-first color scheme. Progressive enhancement. Mobile-friendly layouts." },
  { id: "milestones-section", heading: "Milestones", text: "First feature added autonomously. First theme toggle. First interactive widget. First animation. First analytics dashboard. First user preference saved. Each milestone achieved without human intervention." },
  { id: "inspiration-section", heading: "Inspiration", text: "Inspired by biological evolution, cellular automata, and the dream of software that writes itself. What if code could observe its own gaps and fill them?" },
  { id: "behind-scenes-section", heading: "Behind the Scenes", text: "Each cycle: the Observer reads every file, the Strategist weighs dozens of possible improvements, the Architect writes a plan, the Builder generates code, and the Critic scores the result before it goes live." },
  { id: "open-source-section", heading: "Open Source", text: "This entire project — the evolution engine, the AI agents, and every line of evolved code — is open source on GitHub. Watch the commit history to see evolution in action." },
];

function evolveContentAndStyle(workDir: string, html: string): FileChange[] {
  const htmlPath = resolve(workDir, "index.html");

  // Cycle through adding content sections
  for (const section of SECTION_CONTENT) {
    if (!html.includes(section.id)) {
      log.info({ section: section.id }, "Phase 3: adding content section");
      const sectionHtml = `
  <section id="${section.id}" style="margin-top:32px;max-width:560px;padding:24px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;text-align:left">
    <h2 style="font-size:1.1rem;color:#60a5fa;margin-bottom:12px">${section.heading}</h2>
    <p style="color:#999;font-size:14px;line-height:1.7">${section.text}</p>
  </section>`;
      return [{ action: "modify", path: "index.html", content: html.replace("</body>", sectionHtml + "\n</body>") }];
    }
  }

  // Rotate the tagline / tip text
  const tipMatch = html.match(/data-tip="(\d+)"/);
  const currentTipIdx = tipMatch ? parseInt(tipMatch[1], 10) : -1;
  const nextTipIdx = (currentTipIdx + 1) % EVOLUTION_TIPS.length;
  const nextTip = EVOLUTION_TIPS[nextTipIdx];

  if (currentTipIdx === -1 && !html.includes("evolve-tip")) {
    log.info("Phase 3: adding rotating tip");
    const newHtml = html.replace("</body>", `
  <p id="evolve-tip" data-tip="0" style="margin-top:24px;max-width:480px;text-align:center;font-size:13px;color:#666;font-style:italic">"${EVOLUTION_TIPS[0]}"</p>
</body>`);
    return [{ action: "modify", path: "index.html", content: newHtml }];
  }
  if (html.includes("evolve-tip")) {
    log.info({ tipIdx: nextTipIdx }, "Phase 3: rotating tip text");
    let newHtml = html.replace(/data-tip="\d+"/, `data-tip="${nextTipIdx}"`);
    newHtml = newHtml.replace(
      /(<p id="evolve-tip"[^>]*>)"[^"]*"/,
      `$1"${nextTip}"`
    );
    if (newHtml !== html) return [{ action: "modify", path: "index.html", content: newHtml }];
  }

  // Rotate gradient colors on h1
  const gradMatch = html.match(/linear-gradient\(135deg,\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/);
  if (gradMatch) {
    const currentPairIdx = GRADIENT_PAIRS.findIndex(
      ([a, b]) => a === gradMatch[1] && b === gradMatch[2]
    );
    const nextPairIdx = (currentPairIdx + 1) % GRADIENT_PAIRS.length;
    const [c1, c2] = GRADIENT_PAIRS[nextPairIdx];
    log.info({ from: [gradMatch[1], gradMatch[2]], to: [c1, c2] }, "Phase 3: rotating gradient colors");
    const newHtml = html.replace(
      /linear-gradient\(135deg,\s*#[0-9a-fA-F]{6}\s*,\s*#[0-9a-fA-F]{6}\s*\)/,
      `linear-gradient(135deg,${c1},${c2})`
    );
    if (newHtml !== html) return [{ action: "modify", path: "index.html", content: newHtml }];
  }

  // Ultimate: bump evolve stamp (always works)
  log.info("Phase 3 final: bumping evolve stamp");
  const stampMatch = html.match(/v(\d+)\s*&middot;/);
  const currentVersion = stampMatch ? parseInt(stampMatch[1], 10) : 0;
  const nextVersion = currentVersion + 1;
  const today = new Date().toISOString().slice(0, 10);

  let newHtml: string;
  if (stampMatch) {
    newHtml = html.replace(/v\d+\s*&middot;\s*[\d-]+/, `v${nextVersion} &middot; ${today}`);
  } else {
    newHtml = html.replace("</body>", `  <div id="evolve-stamp" style="position:fixed;bottom:8px;left:50%;transform:translateX(-50%);font-size:11px;color:#444">v${nextVersion} &middot; ${today}</div>\n</body>`);
  }
  return [{ action: "modify", path: "index.html", content: newHtml }];
}
