import "../core/config.js";
import { db, schema } from "../db/index.js";
import { runCycle } from "./cycle.js";
import { childLogger } from "../core/logger.js";
import { nanoid } from "nanoid";
import { config } from "../core/config.js";

const log = childLogger("evolve-now");

async function main() {
  log.info("Triggering manual evolution cycle");

  const existing = await db.select().from(schema.projects).limit(1);
  let projectId: string;

  if (existing.length) {
    projectId = existing[0].id;
  } else {
    projectId = nanoid();
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "Evolving App",
      description: "An application that improves itself autonomously",
      appDir: config.app.dir,
      createdAt: now,
      updatedAt: now,
    });
  }

  const result = await runCycle(projectId);
  log.info(result, "Evolution cycle complete");
  process.exit(0);
}

main().catch((e) => {
  log.error({ error: e.message }, "Evolution failed");
  process.exit(1);
});
