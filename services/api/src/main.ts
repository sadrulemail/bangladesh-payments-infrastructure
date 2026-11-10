import { MODULE_LABELS, deployment } from "./chain/network";
import { config } from "./config";
import { migrate } from "./db/migrate";
import { pool } from "./db/pool";
import { buildServer } from "./http/server";
import { indexer } from "./indexer/indexer";
import { reconcile } from "./ledger/reconciliation";

/** Module wallets hold funds in transit; give them a name wherever an account label is shown. */
async function labelModules(): Promise<void> {
  for (const [name, address] of Object.entries(deployment.contracts)) {
    await pool.query(
      `INSERT INTO account_profiles (address, label)
       VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label`,
      [address.toLowerCase(), MODULE_LABELS[name as keyof typeof MODULE_LABELS]],
    );
  }
}

function scheduleReconciliation(): NodeJS.Timeout {
  const timer = setInterval(() => {
    reconcile("schedule").catch((error) => console.error("Scheduled reconciliation failed", error));
  }, config.reconciliationMinutes * 60_000);
  return timer.unref();
}

async function main(): Promise<void> {
  await migrate();
  await labelModules();
  await indexer.start();

  const app = await buildServer();
  await app.listen({ host: config.http.host, port: config.http.port });
  const reconciliation = scheduleReconciliation();
  console.log(
    `TakaRail API on http://${config.http.host}:${config.http.port} (docs at /docs), block ${indexer.position}`,
  );

  const shutdown = async () => {
    clearInterval(reconciliation);
    indexer.stop();
    await app.close();
    await pool.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
