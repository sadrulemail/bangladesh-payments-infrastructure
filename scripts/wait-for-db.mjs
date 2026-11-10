/**
 * Waits until the Postgres container accepts connections, so the next step can migrate at once.
 * Used by `pnpm db:up`.
 */
import { spawnSync } from "node:child_process";

const ATTEMPTS = 40;
const PAUSE_MS = 1_500;

const isReady = () =>
  spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "pg_isready", "--username", "takarail", "--dbname", "takarail"],
    {
      stdio: "ignore",
    },
  ).status === 0;

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  if (isReady()) {
    console.log("Postgres is accepting connections");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
}

console.error("Postgres did not become ready in time");
process.exit(1);
