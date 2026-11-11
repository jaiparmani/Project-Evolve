// Launcher for the compiled TypeScript server
import { execFile } from "child_process";
import { resolve } from "path";

// Resolve the compiled server file in the dist directory
const serverPath = resolve(import.meta.dirname, "dist", "server.js");

// Execute the compiled server
execFile(process.execPath, [serverPath], { stdio: "inherit" });
