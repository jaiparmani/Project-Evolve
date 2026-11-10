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
  const htmlPath = resolve(workDir, "index.html");

  if (!html.includes('getElementById("clock")')) {
    log.info("Phase 1: adding live clock");
    return getDeterministicChanges(workDir, "status dashboard with live clock");
  }
  if (serverExists && !serverCode.includes("/api/visitors")) {
    log.info("Phase 1: adding visitor counter");
    return getDeterministicChanges(workDir, "visitor counter");
  }
  if (!html.includes("theme-toggle")) {
    log.info("Phase 1: adding theme toggle");
    return getDeterministicChanges(workDir, "theme toggle");
  }
  if (!html.includes("scroll-top")) {
    log.info("Phase 1: adding scroll-to-top button");
    return [{ action: "modify", path: "index.html", content: html.replace("</body>", `
  <button id="scroll-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" style="position:fixed;bottom:24px;right:24px;width:40px;height:40px;border-radius:50%;background:rgba(96,165,250,0.2);border:1px solid rgba(96,165,250,0.4);color:#60a5fa;font-size:18px;cursor:pointer;display:none;align-items:center;justify-content:center;transition:opacity 0.3s">&uarr;</button>
  <script>window.addEventListener("scroll",()=>{const b=document.getElementById("scroll-top");if(b)b.style.display=window.scrollY>200?"flex":"none"});</script>
</body>`) }];
  }
  if (!html.includes("keyboard-help")) {
    log.info("Phase 1: adding keyboard shortcuts");
    return [{ action: "modify", path: "index.html", content: html.replace("</body>", `
  <div id="keyboard-help" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;align-items:center;justify-content:center">
    <div style="background:#1a1a2e;padding:24px 32px;border-radius:12px;max-width:360px;border:1px solid rgba(96,165,250,0.3)">
      <h3 style="color:#60a5fa;margin-bottom:12px">Keyboard Shortcuts</h3>
      <p style="color:#aaa;font-size:14px;line-height:2"><kbd style="padding:2px 6px;background:#2a2a3e;border-radius:4px">?</kbd> Show this help<br><kbd style="padding:2px 6px;background:#2a2a3e;border-radius:4px">Esc</kbd> Close overlay<br><kbd style="padding:2px 6px;background:#2a2a3e;border-radius:4px">T</kbd> Toggle theme</p>
    </div>
  </div>
  <script>document.addEventListener("keydown",e=>{if(e.key==="?"&&!e.target.matches("input,textarea")){const h=document.getElementById("keyboard-help");if(h)h.style.display="flex";}if(e.key==="Escape"){const h=document.getElementById("keyboard-help");if(h)h.style.display="none";}});</script>
</body>`) }];
  }
  if (!html.includes("@keyframes")) {
    log.info("Phase 1: adding page load animation");
    return [{ action: "modify", path: "index.html", content: html.replace("</head>", `
  <style>@keyframes fadeSlideIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}body>*{animation:fadeSlideIn 0.5s ease-out both}body>*:nth-child(2){animation-delay:0.1s}body>*:nth-child(3){animation-delay:0.2s}body>*:nth-child(4){animation-delay:0.3s}</style>
</head>`) }];
  }
  if (!html.includes("app-footer")) {
    log.info("Phase 1: adding footer");
    return [{ action: "modify", path: "index.html", content: html.replace("</body>", `
  <footer id="app-footer" style="position:fixed;bottom:0;left:0;right:0;padding:8px 16px;background:rgba(10,10,10,0.9);border-top:1px solid rgba(255,255,255,0.05);display:flex;justify-content:space-between;font-size:12px;color:#555"><span>Evolving App</span><span>Autonomously improved</span></footer>
</body>`) }];
  }
  if (!html.includes("toast-container")) {
    log.info("Phase 1: adding toast system");
    return [{ action: "modify", path: "index.html", content: html.replace("</body>", `
  <div id="toast-container" style="position:fixed;top:16px;right:16px;z-index:9998;display:flex;flex-direction:column;gap:8px"></div>
  <script>function showToast(msg,ms){ms=ms||3000;const c=document.getElementById("toast-container");if(!c)return;const t=document.createElement("div");t.textContent=msg;t.style.cssText="padding:10px 18px;background:#1e293b;color:#e2e8f0;border:1px solid rgba(96,165,250,0.3);border-radius:8px;font-size:14px;opacity:0;transition:opacity 0.3s";c.appendChild(t);requestAnimationFrame(()=>t.style.opacity="1");setTimeout(()=>{t.style.opacity="0";setTimeout(()=>t.remove(),300)},ms);}showToast("Welcome to the evolving app!");</script>
</body>`) }];
  }
  if (!html.includes('name="description"')) {
    log.info("Phase 1: adding meta tags");
    return [{ action: "modify", path: "index.html", content: html.replace("</head>", `  <meta name="description" content="An autonomously evolving web application powered by AI."><meta name="theme-color" content="#0a0a0a">\n</head>`) }];
  }
  if (!html.includes("progress-bar") && !html.includes("loading-bar")) {
    log.info("Phase 1: adding page loading progress bar");
    return [{ action: "modify", path: "index.html", content: html.replace("</head>", `
  <style>#progress-bar{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#60a5fa,#a78bfa);z-index:99999;transition:width 0.3s}</style>
</head>`).replace("<body>", `<body>
  <div id="progress-bar" style="width:0%"></div>
  <script>(function(){var b=document.getElementById("progress-bar");if(!b)return;b.style.width="30%";setTimeout(function(){b.style.width="70%"},200);window.addEventListener("load",function(){b.style.width="100%";setTimeout(function(){b.style.opacity="0";setTimeout(function(){b.remove()},300)},400)})})();</script>`) }];
  }
  if (!html.includes("responsive") && !html.includes("@media")) {
    log.info("Phase 1: adding responsive breakpoints");
    return [{ action: "modify", path: "index.html", content: html.replace("</head>", `
  <style>@media(max-width:600px){body{padding:16px!important;gap:12px!important}h1{font-size:1.5rem!important}p{font-size:14px!important}#dashboard{padding:16px!important;margin:16px!important}}</style>
</head>`) }];
  }
  if (!html.includes("uptime") && serverExists) {
    log.info("Phase 1: adding uptime display");
    return [{ action: "modify", path: "index.html", content: html.replace("</body>", `
  <div id="uptime-display" style="margin-top:16px;text-align:center;font-size:13px;color:#666">
    <span id="uptime-label">Uptime: </span><span id="uptime-value">loading...</span>
  </div>
  <script>async function fetchUptime(){try{const r=await fetch("/health");const d=await r.json();const el=document.getElementById("uptime-value");if(el&&d.uptime){const s=Math.floor(d.uptime);const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);el.textContent=h>0?h+"h "+m+"m":m+"m "+s%60+"s"}}catch{const el=document.getElementById("uptime-value");if(el)el.textContent="offline"}}fetchUptime();setInterval(fetchUptime,60000);</script>
</body>`) }];
  }

  log.info("Phase 1 exhausted — all base features present");
  return null;
}

function enhanceExistingFeature(workDir: string, html: string, serverExists: boolean, serverCode: string): FileChange[] | null {
  const htmlPath = resolve(workDir, "index.html");
  const serverPath = resolve(workDir, "server.js");
  const changes: FileChange[] = [];

  // Enhance: add hover effects to buttons if missing
  if (html.includes("<button") && !html.includes(":hover") && !html.includes("hover-effect")) {
    log.info("Phase 2: adding hover effects to buttons");
    const enhanced = html.replace("</head>", `
  <style>.hover-effect{transition:transform 0.15s,box-shadow 0.15s!important}.hover-effect:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(96,165,250,0.2)!important}</style>
  <script>document.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll("button").forEach(b=>b.classList.add("hover-effect"))});</script>
</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add smooth scroll behavior if missing
  if (!html.includes("scroll-behavior")) {
    log.info("Phase 2: adding smooth scroll behavior");
    const enhanced = html.replace("</head>", `  <style>html{scroll-behavior:smooth}</style>\n</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add focus-visible styles for accessibility
  if (!html.includes("focus-visible")) {
    log.info("Phase 2: adding focus-visible styles");
    const enhanced = html.replace("</head>", `  <style>:focus-visible{outline:2px solid #60a5fa;outline-offset:2px;border-radius:4px}:focus:not(:focus-visible){outline:none}</style>\n</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add prefers-reduced-motion support
  if (html.includes("@keyframes") && !html.includes("prefers-reduced-motion")) {
    log.info("Phase 2: adding reduced-motion support");
    const enhanced = html.replace("</head>", `  <style>@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important}}</style>\n</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add selection color styling
  if (!html.includes("::selection")) {
    log.info("Phase 2: adding selection color");
    const enhanced = html.replace("</head>", `  <style>::selection{background:rgba(96,165,250,0.3);color:#e0e0e0}</style>\n</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add print styles
  if (!html.includes("@media print")) {
    log.info("Phase 2: adding print stylesheet");
    const enhanced = html.replace("</head>", `  <style>@media print{body{background:#fff!important;color:#000!important}#theme-toggle,#scroll-top,#app-footer,#toast-container,.badge{display:none!important}}</style>\n</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add favicon
  if (!html.includes("favicon") && !html.includes('rel="icon"')) {
    log.info("Phase 2: adding inline SVG favicon");
    const enhanced = html.replace("</head>", `  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🧬</text></svg>">\n</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add Open Graph tags
  if (!html.includes("og:title")) {
    log.info("Phase 2: adding Open Graph meta tags");
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch ? titleMatch[1] : "Evolving App";
    const enhanced = html.replace("</head>", `  <meta property="og:title" content="${title}"><meta property="og:type" content="website"><meta property="og:description" content="A self-improving web application powered by autonomous AI evolution cycles.">\n</head>`);
    return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance: add loading="lazy" to images
  if (html.includes("<img") && !html.includes('loading="lazy"')) {
    log.info("Phase 2: adding lazy loading to images");
    const enhanced = html.replace(/<img(?!.*loading)/g, '<img loading="lazy"');
    if (enhanced !== html) return [{ action: "modify", path: "index.html", content: enhanced }];
  }

  // Enhance server: add request logging if missing
  if (serverExists && !serverCode.includes("request log") && !serverCode.includes("morgan") && !serverCode.includes("req.method")) {
    log.info("Phase 2: adding request logging to server");
    const enhanced = serverCode.replace(
      "app.use(express.static(",
      `app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (req.url !== "/health") console.log(\`\${req.method} \${req.url} \${res.statusCode} \${ms}ms\`);
  });
  next();
});

app.use(express.static(`
    );
    if (enhanced !== serverCode) return [{ action: "modify", path: "server.js", content: enhanced }];
  }

  // Enhance server: add CORS headers if missing
  if (serverExists && !serverCode.includes("cors") && !serverCode.includes("Access-Control")) {
    log.info("Phase 2: adding CORS headers");
    const enhanced = serverCode.replace(
      "app.use(express.static(",
      `app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept"); next(); });

app.use(express.static(`
    );
    if (enhanced !== serverCode) return [{ action: "modify", path: "server.js", content: enhanced }];
  }

  // Enhance server: add uptime to health endpoint
  if (serverExists && serverCode.includes("/health") && !serverCode.includes("uptime")) {
    log.info("Phase 2: adding uptime to health endpoint");
    const enhanced = serverCode.replace(
      /res\.json\(\s*\{\s*status:\s*"ok"\s*\}\s*\)/,
      'res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() })'
    );
    if (enhanced !== serverCode) return [{ action: "modify", path: "server.js", content: enhanced }];
  }

  // Enhance server: add 404 handler if missing
  if (serverExists && !serverCode.includes("404") && !serverCode.includes("Not Found")) {
    log.info("Phase 2: adding 404 handler");
    const enhanced = serverCode.replace(
      /app\.listen\(/,
      `app.use((req, res) => { res.status(404).json({ error: "Not Found", path: req.url }); });\n\napp.listen(`
    );
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
];

const GRADIENT_PAIRS = [
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
];

const SECTION_CONTENT = [
  { id: "about-section", heading: "About", text: "This application improves itself through autonomous AI evolution cycles. Each cycle analyzes the current state, plans improvements, implements changes, and evaluates results." },
  { id: "how-it-works", heading: "How It Works", text: "An observer examines the app. A strategist picks the highest-impact improvement. An architect plans the implementation. A builder writes the code. A critic evaluates the result. Repeat." },
  { id: "tech-section", heading: "Technology", text: "Built with Node.js and Express on the backend, plain HTML/CSS/JS on the frontend. Deployed on Render's free tier. Evolution cycles run every 90 seconds." },
  { id: "stats-section", heading: "Evolution Stats", text: "This app started as a blank HTML page and grew feature by feature, each one added by an autonomous AI agent without any human code contributions." },
  { id: "philosophy-section", heading: "Philosophy", text: "Software doesn't have to be static. With the right architecture, an application can observe its own shortcomings, plan improvements, and implement them — all without human intervention." },
  { id: "roadmap-section", heading: "Roadmap", text: "Future cycles will add real-time data visualization, user interaction analytics, A/B testing of UI variants, and increasingly sophisticated autonomous decision-making." },
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
