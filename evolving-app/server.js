import express from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.type("html").send(readFileSync(resolve(__dirname, "index.html"), "utf-8"));
});

let visitorCount = 0;
app.get("/api/visitors", (req, res) => {
  visitorCount++;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  res.json({ count: visitorCount, greeting });
});

app.use(express.static(__dirname));

// Global error handlers
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

app.listen(PORT, () => {
  console.log(`Evolving App running at http://localhost:${PORT}`);
});
