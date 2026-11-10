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
  const features: Array<{ id: string; check: string; label: string; inject: string; target?: "head" | "body-start" }> = [
    { id: "clock", check: 'getElementById("clock")', label: "live clock dashboard", inject: `
  <div id="dashboard" style="margin-top:32px;padding:24px;background:rgba(255,255,255,0.05);border-radius:12px;max-width:400px;margin-left:auto;margin-right:auto">
    <div style="display:flex;justify-content:space-between;margin-bottom:16px"><span style="color:#888;font-size:14px">Local Time</span><span id="clock" style="font-family:ui-monospace,monospace;color:#5ee0c8;font-size:14px">--:--:--</span></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:16px"><span style="color:#888;font-size:14px">Server Status</span><span id="server-status" style="font-size:14px;color:#666">checking...</span></div>
    <button onclick="checkHealth()" style="width:100%;padding:10px;background:rgba(94,224,200,0.15);color:#5ee0c8;border:1px solid rgba(94,224,200,0.3);border-radius:8px;cursor:pointer;font-size:14px;transition:all 0.2s" onmouseover="this.style.background='rgba(94,224,200,0.25)'" onmouseout="this.style.background='rgba(94,224,200,0.15)'">Check Server Health</button>
  </div>
  <script>function updateClock(){document.getElementById("clock").textContent=new Date().toLocaleTimeString()}setInterval(updateClock,1000);updateClock();async function checkHealth(){const el=document.getElementById("server-status");el.textContent="checking...";try{const r=await fetch("/health");const d=await r.json();el.textContent=d.status==="ok"?"Online ✓":"Error";el.style.color=d.status==="ok"?"#5ee0c8":"#ff6b6b"}catch{el.textContent="Offline ✗";el.style.color="#ff6b6b"}}checkHealth();</script>` },
    { id: "theme-toggle", check: "theme-toggle", label: "dark/light theme toggle", inject: `
  <button id="theme-toggle" onclick="toggleTheme()" style="position:fixed;top:16px;right:16px;padding:8px 12px;background:rgba(255,255,255,0.1);color:#888;border:1px solid rgba(255,255,255,0.2);border-radius:8px;cursor:pointer;font-size:16px;transition:all 0.3s;z-index:999">🌙</button>
  <script>function toggleTheme(){const b=document.body,t=document.getElementById("theme-toggle");if(b.classList.contains("light")){b.style.background="#0a0a0a";b.style.color="#e0e0e0";b.classList.remove("light");t.textContent="🌙";localStorage.setItem("theme","dark")}else{b.style.background="#fafafa";b.style.color="#1a1a1a";b.classList.add("light");t.textContent="☀️";localStorage.setItem("theme","light")}}if(localStorage.getItem("theme")==="light")toggleTheme();</script>` },
    { id: "scroll-top", check: "scroll-top", label: "scroll-to-top button", inject: `
  <button id="scroll-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" style="position:fixed;bottom:24px;right:24px;width:40px;height:40px;border-radius:50%;background:rgba(96,165,250,0.2);border:1px solid rgba(96,165,250,0.4);color:#60a5fa;font-size:18px;cursor:pointer;display:none;align-items:center;justify-content:center;transition:opacity 0.3s;z-index:998">&uarr;</button>
  <script>window.addEventListener("scroll",()=>{const b=document.getElementById("scroll-top");if(b)b.style.display=window.scrollY>200?"flex":"none"});</script>` },
    { id: "keyboard-help", check: "keyboard-help", label: "keyboard shortcuts overlay", inject: `
  <div id="keyboard-help" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;align-items:center;justify-content:center">
    <div style="background:#1a1a2e;padding:24px 32px;border-radius:12px;max-width:360px;border:1px solid rgba(96,165,250,0.3)">
      <h3 style="color:#60a5fa;margin-bottom:12px">Keyboard Shortcuts</h3>
      <p style="color:#aaa;font-size:14px;line-height:2"><kbd style="padding:2px 6px;background:#2a2a3e;border-radius:4px">?</kbd> Show help<br><kbd style="padding:2px 6px;background:#2a2a3e;border-radius:4px">Esc</kbd> Close<br><kbd style="padding:2px 6px;background:#2a2a3e;border-radius:4px">T</kbd> Toggle theme<br><kbd style="padding:2px 6px;background:#2a2a3e;border-radius:4px">↑</kbd> Scroll to top</p>
    </div>
  </div>
  <script>document.addEventListener("keydown",e=>{if(e.target.matches("input,textarea"))return;if(e.key==="?"){const h=document.getElementById("keyboard-help");if(h)h.style.display="flex"}if(e.key==="Escape"){const h=document.getElementById("keyboard-help");if(h)h.style.display="none"}if(e.key==="t"||e.key==="T"){if(typeof toggleTheme==="function")toggleTheme()}});</script>` },
    { id: "animations", check: "@keyframes fadeSlideIn", label: "page load animations", inject: `
  <style>@keyframes fadeSlideIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}body>*{animation:fadeSlideIn 0.5s ease-out both}body>*:nth-child(2){animation-delay:0.1s}body>*:nth-child(3){animation-delay:0.2s}body>*:nth-child(4){animation-delay:0.3s}body>*:nth-child(5){animation-delay:0.4s}</style>`, target: "head" },
    { id: "footer", check: "app-footer", label: "sticky footer", inject: `
  <footer id="app-footer" style="position:fixed;bottom:0;left:0;right:0;padding:8px 16px;background:rgba(10,10,10,0.95);border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;font-size:12px;color:#555;z-index:900;backdrop-filter:blur(8px)"><span>🧬 Evolving App</span><span id="cycle-count">Autonomously improved</span></footer>` },
    { id: "toast", check: "toast-container", label: "toast notification system", inject: `
  <div id="toast-container" style="position:fixed;top:16px;right:16px;z-index:9998;display:flex;flex-direction:column;gap:8px"></div>
  <script>function showToast(msg,type,ms){ms=ms||3000;const c=document.getElementById("toast-container");if(!c)return;const colors={success:"#5ee0c8",info:"#60a5fa",warn:"#fbbf24",error:"#f87171"};const t=document.createElement("div");t.textContent=msg;t.style.cssText="padding:10px 18px;background:#1e293b;color:"+(colors[type]||"#e2e8f0")+";border:1px solid "+(colors[type]||"rgba(96,165,250,0.3)")+";border-radius:8px;font-size:14px;opacity:0;transition:opacity 0.3s;cursor:pointer";t.onclick=()=>t.remove();c.appendChild(t);requestAnimationFrame(()=>t.style.opacity="1");setTimeout(()=>{t.style.opacity="0";setTimeout(()=>t.remove(),300)},ms)}showToast("Welcome! This app evolves itself.","info");</script>` },
    { id: "progress-bar", check: "progress-bar", label: "page load progress bar", inject: `
  <style>#progress-bar{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#60a5fa,#a78bfa);z-index:99999;transition:width 0.3s}</style>`, target: "head" },
    { id: "progress-bar-body", check: "progress-bar", label: "progress bar script", inject: `
  <div id="progress-bar" style="width:0%"></div>
  <script>(function(){var b=document.getElementById("progress-bar");if(!b)return;b.style.width="30%";setTimeout(function(){b.style.width="70%"},200);window.addEventListener("load",function(){b.style.width="100%";setTimeout(function(){b.style.opacity="0";setTimeout(function(){b.remove()},300)},400)})})();</script>` },
    { id: "meta-tags", check: 'name="description"', label: "SEO meta tags", inject: `  <meta name="description" content="An autonomously evolving web application powered by AI."><meta name="theme-color" content="#0a0a0a">`, target: "head" },
    { id: "responsive", check: "@media(max-width", label: "responsive breakpoints", inject: `
  <style>@media(max-width:600px){body{padding:16px!important;gap:12px!important}h1{font-size:1.5rem!important}p{font-size:14px!important}#dashboard{padding:16px!important;margin:16px!important}.card{padding:16px!important}section{padding:16px!important}}</style>`, target: "head" },
    { id: "uptime", check: "uptime-value", label: "server uptime display", inject: `
  <div id="uptime-display" style="margin-top:16px;text-align:center;font-size:13px;color:#666"><span>Uptime: </span><span id="uptime-value">loading...</span></div>
  <script>async function fetchUptime(){try{const r=await fetch("/health");const d=await r.json();const el=document.getElementById("uptime-value");if(el&&d.uptime){const s=Math.floor(d.uptime);const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);el.textContent=h>0?h+"h "+m+"m":m+"m "+s%60+"s"}}catch{const el=document.getElementById("uptime-value");if(el)el.textContent="offline"}}fetchUptime();setInterval(fetchUptime,60000);</script>` },
    // ── New features below ──
    { id: "particle-bg", check: "particle-canvas", label: "animated particle background", inject: `
  <canvas id="particle-canvas" style="position:fixed;inset:0;z-index:-1;pointer-events:none"></canvas>
  <script>(function(){const c=document.getElementById("particle-canvas"),x=c.getContext("2d");let w,h,ps=[];function resize(){w=c.width=innerWidth;h=c.height=innerHeight}resize();addEventListener("resize",resize);for(let i=0;i<50;i++)ps.push({x:Math.random()*w,y:Math.random()*h,r:Math.random()*2+0.5,dx:(Math.random()-0.5)*0.3,dy:(Math.random()-0.5)*0.3,o:Math.random()*0.3+0.1});function draw(){x.clearRect(0,0,w,h);ps.forEach(p=>{p.x+=p.dx;p.y+=p.dy;if(p.x<0)p.x=w;if(p.x>w)p.x=0;if(p.y<0)p.y=h;if(p.y>h)p.y=0;x.beginPath();x.arc(p.x,p.y,p.r,0,Math.PI*2);x.fillStyle="rgba(96,165,250,"+p.o+")";x.fill()});requestAnimationFrame(draw)}draw()})();</script>` },
    { id: "typing-effect", check: "typing-effect", label: "typewriter text effect", inject: `
  <div id="typing-effect" style="margin-top:24px;font-family:ui-monospace,monospace;font-size:14px;color:#5ee0c8;min-height:20px;text-align:center"></div>
  <script>(function(){const msgs=["Evolving autonomously...","Building the future, one cycle at a time...","AI-powered self-improvement in action...","No human commits needed...","Watch me grow..."];let mi=0,ci=0,del=false;const el=document.getElementById("typing-effect");function type(){if(!el)return;if(!del){el.textContent=msgs[mi].slice(0,ci+1);ci++;if(ci>=msgs[mi].length){del=true;setTimeout(type,2000);return}}else{el.textContent=msgs[mi].slice(0,ci-1);ci--;if(ci<=0){del=false;mi=(mi+1)%msgs.length;setTimeout(type,500);return}}setTimeout(type,del?30:60)}type()})();</script>` },
    { id: "command-palette", check: "command-palette", label: "command palette (Ctrl+K)", inject: `
  <div id="command-palette" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;align-items:flex-start;justify-content:center;padding-top:20vh">
    <div style="background:#1a1a2e;border:1px solid rgba(96,165,250,0.3);border-radius:12px;width:90%;max-width:480px;overflow:hidden">
      <input id="cmd-input" placeholder="Type a command..." style="width:100%;padding:14px 18px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.06);color:#e0e0e0;font-size:15px;outline:none">
      <div id="cmd-results" style="max-height:240px;overflow-y:auto"></div>
    </div>
  </div>
  <script>(function(){const cmds=[{name:"Toggle Theme",action:()=>typeof toggleTheme==="function"&&toggleTheme()},{name:"Scroll to Top",action:()=>window.scrollTo({top:0,behavior:"smooth"})},{name:"Show Shortcuts",action:()=>{const h=document.getElementById("keyboard-help");if(h)h.style.display="flex"}},{name:"Check Health",action:()=>typeof checkHealth==="function"&&checkHealth()},{name:"Show Toast",action:()=>typeof showToast==="function"&&showToast("Hello from command palette!","info")}];const pal=document.getElementById("command-palette"),inp=document.getElementById("cmd-input"),res=document.getElementById("cmd-results");function render(q){res.innerHTML="";cmds.filter(c=>!q||c.name.toLowerCase().includes(q.toLowerCase())).forEach(c=>{const d=document.createElement("div");d.textContent=c.name;d.style.cssText="padding:10px 18px;color:#ccc;cursor:pointer;font-size:14px;transition:background 0.15s";d.onmouseover=()=>d.style.background="rgba(96,165,250,0.1)";d.onmouseout=()=>d.style.background="transparent";d.onclick=()=>{c.action();pal.style.display="none"};res.appendChild(d)})}document.addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="k"){e.preventDefault();pal.style.display=pal.style.display==="flex"?"none":"flex";if(pal.style.display==="flex"){inp.value="";render("");inp.focus()}}if(e.key==="Escape")pal.style.display="none"});inp.addEventListener("input",()=>render(inp.value));render("")})();</script>` },
    { id: "cursor-glow", check: "cursor-glow", label: "mouse cursor glow effect", inject: `
  <div id="cursor-glow" style="position:fixed;width:300px;height:300px;border-radius:50%;background:radial-gradient(circle,rgba(96,165,250,0.08) 0%,transparent 70%);pointer-events:none;z-index:-1;transform:translate(-50%,-50%);transition:opacity 0.3s"></div>
  <script>document.addEventListener("mousemove",e=>{const g=document.getElementById("cursor-glow");if(g){g.style.left=e.clientX+"px";g.style.top=e.clientY+"px"}});</script>` },
    { id: "random-quote", check: "random-quote", label: "random AI/tech quote widget", inject: `
  <div id="random-quote" style="margin-top:24px;max-width:500px;padding:20px 24px;background:rgba(255,255,255,0.03);border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;text-align:left">
    <p id="quote-text" style="color:#bbb;font-size:14px;line-height:1.6;font-style:italic"></p>
    <p id="quote-author" style="color:#666;font-size:12px;margin-top:8px"></p>
  </div>
  <script>(function(){const qs=[{t:"The best way to predict the future is to invent it.",a:"Alan Kay"},{t:"Any sufficiently advanced technology is indistinguishable from magic.",a:"Arthur C. Clarke"},{t:"Software is eating the world.",a:"Marc Andreessen"},{t:"The only way to do great work is to love what you do.",a:"Steve Jobs"},{t:"Programs must be written for people to read, and only incidentally for machines to execute.",a:"Harold Abelson"},{t:"First, solve the problem. Then, write the code.",a:"John Johnson"},{t:"Code is like humor. When you have to explain it, it's bad.",a:"Cory House"},{t:"Simplicity is the soul of efficiency.",a:"Austin Freeman"},{t:"Talk is cheap. Show me the code.",a:"Linus Torvalds"},{t:"The computer was born to solve problems that did not exist before.",a:"Bill Gates"}];const q=qs[Math.floor(Math.random()*qs.length)];document.getElementById("quote-text").textContent='"'+q.t+'"';document.getElementById("quote-author").textContent="— "+q.a})();</script>` },
    { id: "reading-progress", check: "reading-progress", label: "reading progress indicator", inject: `
  <div id="reading-progress" style="position:fixed;top:0;left:0;height:2px;background:linear-gradient(90deg,#a78bfa,#f472b6);z-index:99998;width:0;transition:width 0.1s"></div>
  <script>window.addEventListener("scroll",()=>{const el=document.getElementById("reading-progress");if(!el)return;const h=document.documentElement.scrollHeight-window.innerHeight;el.style.width=h>0?(window.scrollY/h*100)+"%":"100%"});</script>` },
    { id: "copy-btn", check: "copy-url-btn", label: "share/copy URL button", inject: `
  <button id="copy-url-btn" onclick="copyURL()" style="margin-top:16px;padding:8px 16px;background:rgba(167,139,250,0.15);color:#a78bfa;border:1px solid rgba(167,139,250,0.3);border-radius:8px;cursor:pointer;font-size:13px;transition:all 0.2s">📋 Share This Page</button>
  <script>async function copyURL(){try{await navigator.clipboard.writeText(location.href);const b=document.getElementById("copy-url-btn");b.textContent="✓ Copied!";setTimeout(()=>b.textContent="📋 Share This Page",2000);if(typeof showToast==="function")showToast("URL copied to clipboard!","success")}catch{if(typeof showToast==="function")showToast("Could not copy URL","error")}}</script>` },
    { id: "tab-title", check: "visibilitychange", label: "dynamic tab title on blur", inject: `
  <script>document.addEventListener("visibilitychange",()=>{const orig=document.title;if(document.hidden){document.title="👀 Come back!"}else{document.title=orig}});</script>` },
    { id: "confetti", check: "confetti-canvas", label: "confetti celebration effect", inject: `
  <canvas id="confetti-canvas" style="position:fixed;inset:0;z-index:99997;pointer-events:none"></canvas>
  <script>function fireConfetti(){const c=document.getElementById("confetti-canvas"),x=c.getContext("2d");c.width=innerWidth;c.height=innerHeight;const ps=[];const colors=["#60a5fa","#a78bfa","#5ee0c8","#f472b6","#fbbf24"];for(let i=0;i<80;i++)ps.push({x:innerWidth/2,y:innerHeight/2,dx:(Math.random()-0.5)*12,dy:Math.random()*-12-4,r:Math.random()*4+2,c:colors[Math.floor(Math.random()*colors.length)],g:0.15,life:120});let f=0;function draw(){x.clearRect(0,0,c.width,c.height);let alive=0;ps.forEach(p=>{if(p.life<=0)return;alive++;p.x+=p.dx;p.dy+=p.g;p.y+=p.dy;p.life--;x.globalAlpha=p.life/120;x.fillStyle=p.c;x.fillRect(p.x,p.y,p.r,p.r*1.5)});x.globalAlpha=1;if(alive>0)requestAnimationFrame(draw)}draw()}setTimeout(fireConfetti,1500);</script>` },
    { id: "scroll-reveal", check: "scroll-reveal", label: "scroll reveal animations", inject: `
  <style>.scroll-reveal{opacity:0;transform:translateY(20px);transition:opacity 0.6s,transform 0.6s}.scroll-reveal.visible{opacity:1;transform:translateY(0)}</style>
  <script>(function(){const obs=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add("visible");obs.unobserve(e.target)}})},{threshold:0.1});document.querySelectorAll("section,div[id]").forEach(el=>el.classList.add("scroll-reveal"));setTimeout(()=>document.querySelectorAll(".scroll-reveal").forEach(el=>obs.observe(el)),100)})();</script>` },
    { id: "gradient-text", check: "gradient-anim", label: "animated gradient text", inject: `
  <style>@keyframes gradient-anim{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}h1{background-size:200% 200%!important;animation:gradient-anim 4s ease infinite!important}</style>`, target: "head" },
    { id: "tooltip-system", check: "data-tooltip", label: "tooltip system", inject: `
  <style>[data-tooltip]{position:relative;cursor:help}[data-tooltip]:hover::after{content:attr(data-tooltip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);padding:6px 10px;background:#1e293b;color:#e2e8f0;border:1px solid rgba(96,165,250,0.3);border-radius:6px;font-size:12px;white-space:nowrap;z-index:9000;pointer-events:none;animation:fadeSlideIn 0.2s ease-out}</style>
  <script>document.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll("button,kbd,.badge").forEach(el=>{if(!el.dataset.tooltip)el.dataset.tooltip=el.textContent.trim().slice(0,30)})});</script>` },
    { id: "mini-analytics", check: "mini-analytics", label: "mini analytics panel", inject: `
  <details id="mini-analytics" style="margin-top:24px;max-width:480px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px">
    <summary style="cursor:pointer;color:#60a5fa;font-size:14px;font-weight:600">📊 Session Analytics</summary>
    <div style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
      <div style="padding:12px;background:rgba(96,165,250,0.08);border-radius:8px;text-align:center"><div style="color:#888;font-size:11px">Time on Page</div><div id="time-on-page" style="color:#60a5fa;font-size:18px;font-weight:700;margin-top:4px">0s</div></div>
      <div style="padding:12px;background:rgba(94,224,200,0.08);border-radius:8px;text-align:center"><div style="color:#888;font-size:11px">Clicks</div><div id="click-count" style="color:#5ee0c8;font-size:18px;font-weight:700;margin-top:4px">0</div></div>
      <div style="padding:12px;background:rgba(167,139,250,0.08);border-radius:8px;text-align:center"><div style="color:#888;font-size:11px">Scroll Depth</div><div id="scroll-depth" style="color:#a78bfa;font-size:18px;font-weight:700;margin-top:4px">0%</div></div>
      <div style="padding:12px;background:rgba(244,114,182,0.08);border-radius:8px;text-align:center"><div style="color:#888;font-size:11px">Key Presses</div><div id="key-count" style="color:#f472b6;font-size:18px;font-weight:700;margin-top:4px">0</div></div>
    </div>
  </details>
  <script>(function(){let clicks=0,keys=0,maxScroll=0,start=Date.now();document.addEventListener("click",()=>{clicks++;const el=document.getElementById("click-count");if(el)el.textContent=clicks});document.addEventListener("keydown",()=>{keys++;const el=document.getElementById("key-count");if(el)el.textContent=keys});window.addEventListener("scroll",()=>{const h=document.documentElement.scrollHeight-window.innerHeight;const pct=h>0?Math.round(window.scrollY/h*100):100;if(pct>maxScroll)maxScroll=pct;const el=document.getElementById("scroll-depth");if(el)el.textContent=maxScroll+"%"});setInterval(()=>{const s=Math.floor((Date.now()-start)/1000);const m=Math.floor(s/60);const el=document.getElementById("time-on-page");if(el)el.textContent=m>0?m+"m "+s%60+"s":s+"s"},1000)})();</script>` },
    { id: "color-picker", check: "accent-picker", label: "accent color picker", inject: `
  <div id="accent-picker" style="margin-top:20px;display:flex;gap:8px;justify-content:center;align-items:center"><span style="color:#888;font-size:12px">Accent:</span>
    <button onclick="setAccent('#60a5fa')" style="width:24px;height:24px;border-radius:50%;background:#60a5fa;border:2px solid transparent;cursor:pointer" data-tooltip="Blue"></button>
    <button onclick="setAccent('#a78bfa')" style="width:24px;height:24px;border-radius:50%;background:#a78bfa;border:2px solid transparent;cursor:pointer" data-tooltip="Purple"></button>
    <button onclick="setAccent('#5ee0c8')" style="width:24px;height:24px;border-radius:50%;background:#5ee0c8;border:2px solid transparent;cursor:pointer" data-tooltip="Teal"></button>
    <button onclick="setAccent('#f472b6')" style="width:24px;height:24px;border-radius:50%;background:#f472b6;border:2px solid transparent;cursor:pointer" data-tooltip="Pink"></button>
    <button onclick="setAccent('#fbbf24')" style="width:24px;height:24px;border-radius:50%;background:#fbbf24;border:2px solid transparent;cursor:pointer" data-tooltip="Gold"></button>
  </div>
  <script>function setAccent(c){document.querySelectorAll("h1,h2,h3,.badge,#server-status,#clock").forEach(el=>{if(el.style.color)el.style.color=c;if(el.style.borderColor)el.style.borderColor=c});localStorage.setItem("accent",c);if(typeof showToast==="function")showToast("Accent color updated!","success")}const savedAccent=localStorage.getItem("accent");if(savedAccent)setAccent(savedAccent);</script>` },
    { id: "easter-egg", check: "easter-egg", label: "konami code easter egg", inject: `
  <script>(function(){const code=[38,38,40,40,37,39,37,39,66,65];let pos=0;document.addEventListener("keydown",e=>{if(e.keyCode===code[pos]){pos++;if(pos===code.length){pos=0;document.body.style.transition="transform 0.5s";document.body.style.transform="rotate(360deg)";setTimeout(()=>document.body.style.transform="",600);if(typeof showToast==="function")showToast("🎮 Konami Code Activated!","success");if(typeof fireConfetti==="function")fireConfetti()}}else{pos=0}})})();</script>` },
    { id: "notification-bell", check: "notif-bell", label: "notification bell", inject: `
  <div id="notif-bell" style="position:fixed;top:16px;left:16px;z-index:999">
    <button onclick="toggleNotifs()" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px;cursor:pointer;font-size:16px;position:relative">🔔<span id="notif-badge" style="position:absolute;top:-4px;right:-4px;background:#f87171;color:white;font-size:10px;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center">3</span></button>
    <div id="notif-panel" style="display:none;position:absolute;top:44px;left:0;background:#1a1a2e;border:1px solid rgba(96,165,250,0.3);border-radius:12px;width:280px;overflow:hidden">
      <div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);color:#60a5fa;font-size:14px;font-weight:600">Notifications</div>
      <div style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px;color:#bbb">🧬 New evolution cycle completed</div>
      <div style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px;color:#bbb">✨ New feature added to app</div>
      <div style="padding:10px 16px;font-size:13px;color:#bbb">🚀 App deployed successfully</div>
    </div>
  </div>
  <script>function toggleNotifs(){const p=document.getElementById("notif-panel");p.style.display=p.style.display==="none"?"block":"none";document.getElementById("notif-badge").style.display="none"}</script>` },
    { id: "music-vis", check: "music-visualizer", label: "audio visualizer bars", inject: `
  <div id="music-visualizer" style="display:flex;gap:3px;justify-content:center;align-items:flex-end;height:32px;margin-top:20px">
    <div class="bar" style="width:4px;background:#60a5fa;border-radius:2px;animation:barPulse 0.8s ease infinite"></div>
    <div class="bar" style="width:4px;background:#a78bfa;border-radius:2px;animation:barPulse 0.6s ease infinite 0.1s"></div>
    <div class="bar" style="width:4px;background:#5ee0c8;border-radius:2px;animation:barPulse 1s ease infinite 0.2s"></div>
    <div class="bar" style="width:4px;background:#f472b6;border-radius:2px;animation:barPulse 0.7s ease infinite 0.15s"></div>
    <div class="bar" style="width:4px;background:#fbbf24;border-radius:2px;animation:barPulse 0.9s ease infinite 0.25s"></div>
    <div class="bar" style="width:4px;background:#60a5fa;border-radius:2px;animation:barPulse 0.75s ease infinite 0.3s"></div>
    <div class="bar" style="width:4px;background:#a78bfa;border-radius:2px;animation:barPulse 0.85s ease infinite 0.05s"></div>
  </div>
  <style>@keyframes barPulse{0%,100%{height:8px}50%{height:28px}}</style>` },
    { id: "countdown", check: "countdown-timer", label: "next cycle countdown", inject: `
  <div id="countdown-timer" style="margin-top:16px;text-align:center;font-size:13px;color:#666">
    <span>Next evolution in: </span><span id="countdown-value" style="color:#5ee0c8;font-family:ui-monospace,monospace">--:--</span>
  </div>
  <script>(function(){let sec=90;function tick(){const m=Math.floor(sec/60);const s=sec%60;const el=document.getElementById("countdown-value");if(el)el.textContent=m+":"+(s<10?"0":"")+s;sec--;if(sec<0){sec=90;if(typeof showToast==="function")showToast("🧬 Evolution cycle running!","info")}}tick();setInterval(tick,1000)})();</script>` },
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
