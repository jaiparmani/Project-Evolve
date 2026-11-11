import express from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet());

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.type("html").send(readFileSync(resolve(__dirname, "index.html"), "utf-8"));
});

// New dashboard route
app.get("/dashboard", (req, res) => {
  res.type("html").send(readFileSync(resolve(__dirname, "public", "dashboard.html"), "utf-8"));
});

// Visitor data API – returns an array of visitor objects
app.get("/api/visitors", (req, res) => {
  try {
    const { start, end } = req.query;
    let startDate = start ? new Date(start) : null;
    let endDate = end ? new Date(end) : null;

    if ((start && isNaN(startDate)) || (end && isNaN(endDate))) {
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
app.use(express.static(resolve(__dirname, "public")));

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});