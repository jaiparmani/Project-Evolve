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

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Evolving App running at http://localhost:${PORT}`);
});
