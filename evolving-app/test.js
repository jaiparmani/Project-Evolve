// Basic test suite for the evolving app
const http = require("http");
const assert = require("assert");

const PORT = process.env.TEST_PORT || 3099;
let serverProcess;

async function fetchJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
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
    http.get(`http://localhost:${PORT}${path}`, (res) => {
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

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
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
