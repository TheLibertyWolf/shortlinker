import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeConnections } from "./db.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(root, "migrations");

async function main(): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const exists = await db.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    console.log(`Applying ${file}`);
    await db.query(sql);
    await db.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
  }
}

main().then(closeConnections).catch(async (error) => {
  console.error(error);
  await closeConnections();
  process.exit(1);
});
