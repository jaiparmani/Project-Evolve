import express, { Request, Response, NextFunction } from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import todoRoutes from "./routes/todoRoutes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet());
// JSON body parsing
app.use(express.json());

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
});

// Serve static HTML pages
app.get("/", (req: Request, res: Response) => {
  res.type("html").send(readFileSync(resolve(__dirname, "../index.html"), "utf-8"));
});

app.get("/dashboard", (req: Request, res: Response) => {
  res.type("html").send(readFileSync(resolve(__dirname, "../public", "dashboard.html"), "utf-8"));
});

app.get("/todos", (req: Request, res: Response) => {
  res.type("html").send(readFileSync(resolve(__dirname, "../public", "todos", "index.html"), "utf-8"));
});

// API routes
app.use("/api/todos", todoRoutes);

// Existing visitors API (unchanged)
app.get("/api/visitors", (req: Request, res: Response) => {
  try {
    const { start, end } = req.query as { [key: string]: string | undefined };
    let startDate = start ? new Date(start) : null;
    let endDate = end ? new Date(end) : null;

    if ((start && isNaN(startDate!.getTime())) || (end && isNaN(endDate!.getTime()))) {
      return res.status(400).json({ error: "Invalid date format" });
    }

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
    res.status(500).json({ error: "Server error" });
  }
});

// Global error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Process‑level error handlers
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
  process.exit(1);
});
