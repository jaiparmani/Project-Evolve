import express from "express";
import cors from "cors";
import compression from "compression";
import { config } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { apiRouter } from "../api/routes.js";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";

const log = childLogger("server");
const app = express();

// Gzip compression — biggest single perf win, shrinks 60KB HTML to ~10KB
app.use(compression());
app.use(cors());
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.use("/api", apiRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Serve the evolving child app under /app with cache headers
app.use("/app", express.static(config.app.dir, { maxAge: "5m", etag: true }));
app.get("/app", (_req, res) => {
  const indexPath = resolve(config.app.dir, "index.html");
  if (existsSync(indexPath)) {
    res.type("html").send(readFileSync(indexPath, "utf-8"));
  } else {
    res.type("html").send("<html><body style='background:#0a0a0a;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui'><p>Child app not built yet. Run an evolution cycle first.</p></body></html>");
  }
});

// Dashboard is a static file; read it once and cache it in memory.
const dashboardPath = [resolve(process.cwd(), "src/web/dashboard.html"), resolve(__dirname, "dashboard.html")].find((p) => existsSync(p));
let dashboardCache: string | null = null;
app.get("*", (_req, res) => {
  if (!dashboardCache) {
    dashboardCache = dashboardPath ? readFileSync(dashboardPath, "utf-8") : "<!doctype html><title>Project Evolve</title><p>Dashboard file missing.</p>";
  }
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(dashboardCache);
});

app.listen(config.server.port, () => {
  import("../db/persist.js").then(({ backupOnShutdown }) => backupOnShutdown()).catch(() => {});
  log.info("Control Room running at http://localhost:%d", config.server.port);
  import("../worker/state.js").then(({ startLoop, loadEvolutionModeFromDb }) => {
    loadEvolutionModeFromDb().then(async () => {
      // Clean up stuck cycles from previous deploys
      try {
        const { db, schema } = await import("../db/index.js");
        const { eq } = await import("drizzle-orm");
        await db.update(schema.evolutionCycles)
          .set({ status: "failed", phase: "failed", completedAt: new Date().toISOString(), errorMessage: "Orphaned by redeploy", lessonsLearned: "Cycle was interrupted by a server restart" } as never)
          .where(eq(schema.evolutionCycles.status, "running"));
        log.info("Cleaned up orphaned running cycles");
      } catch (e) { log.warn({ error: (e as Error).message }, "Failed to clean up orphaned cycles"); }

      try {
        const { recoverInterrupted, importRoadmap } = await import("../core/idea-queue.js");
        await recoverInterrupted();
        await importRoadmap();
      } catch (e) { log.warn({ error: (e as Error).message }, "Failed to recover idea queue"); }

      import("../api/routes.js").then(({ ensureProjectAndRunCycle }) => {
        startLoop(ensureProjectAndRunCycle);
        log.info("Auto-evolution loop started on boot");
      });
    });
  });
});
