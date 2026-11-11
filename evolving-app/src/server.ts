import express, { Request, Response, NextFunction } from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet());

app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
});

app.get("/", (req: Request, res: Response) => {
  res.type("html").send(readFileSync(resolve(__dirname, "../index.html"), "utf-8"));
});

// New dashboard route
app.get("/dashboard", (req: Request, res: Response) => {
  res.type("html").send(readFileSync(resolve(__dirname, "../public", "dashboard.html"), "utf-8"));
});

// Serve the Todo UI
app.get("/todos", (req: Request, res: Response) => {
  res.type("html").send(readFileSync(resolve(__dirname, "../public", "todos", "index.html"), "utf-8"));
});

// Visitor data API – returns an array of visitor objects
app.get("/api/visitors", (req: Request, res: Response) => {
  try {
    const { start, end } = req.query as { [key: string]: string | undefined };
    let startDate = start ? new Date(start) : null;
    let endDate = end ? new Date(end) : null;

    if ((start && isNaN(startDate.getTime())) || (end && isNaN(endDate.getTime()))) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    // Generate mock visitor data (10 entries, one per day)
    const now = Date.now();
    const visitors = [];
    for (let i = 0; i < 10; i++) {
      const ts = new Date(now - i * 24 * 60 * 60 * 1000);
      if (startDate && ts < startDate) continue;
      if (endDate && ts > endDate) continue;
      visitors.push({
        id: i + 1,
        ip: `192.168.1.${i + 1}`,
        timestamp: ts.toISOString()
      });
    }
    res.json(visitors);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Serve static assets from the public folder
app.use(express.static(resolve(__dirname, "../public")));

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
