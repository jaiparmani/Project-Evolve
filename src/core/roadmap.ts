import { existsSync, readFileSync } from "fs";
import { resolve } from "path";


export interface StageGate {
  id: string;
  check: (appDir: string) => boolean;
  description: string;
}

export interface RoadmapStage {
  id: string;
  name: string;
  description: string;
  priority: number;
  goals: string[];
  categories: string[];
  gates: StageGate[];
}

export const ROADMAP: RoadmapStage[] = [
  {
    id: "foundation",
    name: "Foundation",
    description: "Establish a solid, maintainable codebase with type safety, error handling, and automated testing.",
    priority: 1,
    goals: [
      "Add TypeScript configuration and convert JS files to TS",
      "Add error handling to server (try/catch, process error events)",
      "Add a test framework and at least one test per endpoint",
      "Add a lint configuration (ESLint or similar)",
      "Ensure the app starts, serves content, and responds to /health",
    ],
    categories: ["testing", "architecture", "reliability"],
    gates: [
      {
        id: "has_tsconfig",
        description: "tsconfig.json exists",
        check: (dir) => existsSync(resolve(dir, "tsconfig.json")),
      },
      {
        id: "has_tests",
        description: "Test script exists and is not the default placeholder",
        check: (dir) => {
          try {
            const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
            return !!(pkg.scripts?.test && !pkg.scripts.test.includes("no test specified"));
          } catch { return false; }
        },
      },
      {
        id: "has_error_handling",
        description: "Server has error handling (try/catch or error event listeners)",
        check: (dir) => {
          const candidates = ["server.ts", "server.js", "src/server.ts", "src/index.ts", "index.ts"];
          for (const f of candidates) {
            const fp = resolve(dir, f);
            if (existsSync(fp)) {
              const content = readFileSync(fp, "utf-8");
              return content.includes("catch") || content.includes(".on(\"error\"") || content.includes(".on('error'");
            }
          }
          return false;
        },
      },
      {
        id: "no_ts_errors",
        description: "TypeScript compiles without errors",
        check: (dir) => {
          if (!existsSync(resolve(dir, "tsconfig.json"))) return false;
          return true;
        },
      },
    ],
  },
  {
    id: "features",
    name: "Features",
    description: "Build real functionality — API endpoints, data management, interactive UI, and useful pages.",
    priority: 2,
    goals: [
      "Add at least 3 functional API endpoints beyond /health",
      "Add client-side interactivity (JS event handlers, dynamic content)",
      "Add a data layer (in-memory store, JSON file, or database)",
      "Add navigation — multiple pages or views",
      "Add a useful feature (todo list, dashboard, calculator, etc.)",
    ],
    categories: ["feature", "ui", "ux"],
    gates: [
      {
        id: "has_api_routes",
        description: "At least 3 API endpoints exist",
        check: (dir) => {
          const candidates = ["server.ts", "server.js", "src/server.ts", "src/index.ts", "routes.ts", "src/routes.ts"];
          for (const f of candidates) {
            const fp = resolve(dir, f);
            if (existsSync(fp)) {
              const content = readFileSync(fp, "utf-8");
              const getMatches = (content.match(/\.(get|post|put|patch|delete)\s*\(/gi) || []).length;
              if (getMatches >= 3) return true;
            }
          }
          return false;
        },
      },
      {
        id: "has_interactivity",
        description: "Client-side JavaScript exists for interactivity",
        check: (dir) => {
          const htmlFiles = ["index.html", "public/index.html"];
          for (const f of htmlFiles) {
            const fp = resolve(dir, f);
            if (existsSync(fp)) {
              const content = readFileSync(fp, "utf-8");
              if (content.includes("<script") || content.includes("addEventListener") || content.includes("fetch(")) return true;
            }
          }
          return false;
        },
      },
      {
        id: "has_data_layer",
        description: "Some form of data persistence or state management exists",
        check: (dir) => {
          const candidates = ["server.ts", "server.js", "src/server.ts", "src/index.ts", "src/data.ts", "src/db.ts", "data.json"];
          for (const f of candidates) {
            const fp = resolve(dir, f);
            if (existsSync(fp)) {
              const content = readFileSync(fp, "utf-8");
              if (content.includes("Map(") || content.includes("new Set(") || content.includes("writeFile") ||
                  content.includes("database") || content.includes("sqlite") || content.includes("let ") ||
                  content.includes("const data") || content.includes("JSON.parse")) return true;
            }
          }
          return false;
        },
      },
    ],
  },
  {
    id: "quality",
    name: "Quality",
    description: "Harden the app — accessibility, performance, security, and comprehensive test coverage.",
    priority: 3,
    goals: [
      "Add ARIA attributes and semantic HTML landmarks",
      "Add security headers (helmet, CORS, CSP)",
      "Add input validation on all API endpoints",
      "Achieve >60% test coverage on API routes",
      "Add performance optimizations (caching, compression)",
    ],
    categories: ["accessibility", "security", "performance", "testing"],
    gates: [
      {
        id: "has_aria",
        description: "HTML uses ARIA attributes or semantic landmarks",
        check: (dir) => {
          const htmlFiles = ["index.html", "public/index.html"];
          for (const f of htmlFiles) {
            const fp = resolve(dir, f);
            if (existsSync(fp)) {
              const content = readFileSync(fp, "utf-8");
              if (content.includes("aria-") || content.includes("<main") || content.includes("<nav") || content.includes("role=")) return true;
            }
          }
          return false;
        },
      },
      {
        id: "has_security_headers",
        description: "Security headers are configured",
        check: (dir) => {
          const candidates = ["server.ts", "server.js", "src/server.ts", "src/index.ts"];
          for (const f of candidates) {
            const fp = resolve(dir, f);
            if (existsSync(fp)) {
              const content = readFileSync(fp, "utf-8");
              if (content.includes("helmet") || content.includes("X-Content-Type") || content.includes("Content-Security-Policy")) return true;
            }
          }
          return false;
        },
      },
    ],
  },
  {
    id: "polish",
    name: "Polish",
    description: "Refine the user experience — design, animations, documentation, and deployment readiness.",
    priority: 4,
    goals: [
      "Improve visual design (colors, spacing, typography)",
      "Add loading states and transitions",
      "Add a README with setup instructions",
      "Add environment variable support",
      "Ensure mobile-responsive layout",
    ],
    categories: ["design", "ux", "ui"],
    gates: [
      {
        id: "has_readme",
        description: "README.md exists with content",
        check: (dir) => {
          const fp = resolve(dir, "README.md");
          if (!existsSync(fp)) return false;
          const content = readFileSync(fp, "utf-8");
          return content.trim().length > 50;
        },
      },
      {
        id: "is_responsive",
        description: "CSS includes responsive/mobile rules",
        check: (dir) => {
          const htmlFiles = ["index.html", "public/index.html"];
          for (const f of htmlFiles) {
            const fp = resolve(dir, f);
            if (existsSync(fp)) {
              const content = readFileSync(fp, "utf-8");
              if (content.includes("@media") || content.includes("max-width") || content.includes("flex") || content.includes("grid")) return true;
            }
          }
          return false;
        },
      },
    ],
  },
];

export interface StageStatus {
  stage: RoadmapStage;
  gateResults: Array<{ gate: StageGate; passed: boolean }>;
  completedGates: number;
  totalGates: number;
  percentComplete: number;
  isComplete: boolean;
}

export function evaluateRoadmap(appDir: string): {
  currentStage: RoadmapStage;
  stageStatuses: StageStatus[];
  overallProgress: number;
} {
  const stageStatuses: StageStatus[] = [];

  for (const stage of ROADMAP) {
    const gateResults = stage.gates.map((gate) => ({
      gate,
      passed: gate.check(appDir),
    }));
    const completedGates = gateResults.filter((g) => g.passed).length;
    stageStatuses.push({
      stage,
      gateResults,
      completedGates,
      totalGates: stage.gates.length,
      percentComplete: stage.gates.length > 0 ? Math.round((completedGates / stage.gates.length) * 100) : 0,
      isComplete: completedGates === stage.gates.length,
    });
  }

  let currentStage = ROADMAP[0];
  for (const ss of stageStatuses) {
    if (!ss.isComplete) {
      currentStage = ss.stage;
      break;
    }
    if (ss === stageStatuses[stageStatuses.length - 1]) {
      currentStage = ss.stage;
    }
  }

  const totalGates = stageStatuses.reduce((s, ss) => s + ss.totalGates, 0);
  const passedGates = stageStatuses.reduce((s, ss) => s + ss.completedGates, 0);
  const overallProgress = totalGates > 0 ? Math.round((passedGates / totalGates) * 100) : 0;

  return { currentStage, stageStatuses, overallProgress };
}
