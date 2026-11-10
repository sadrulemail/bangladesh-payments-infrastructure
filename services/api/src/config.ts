import path from "node:path";
import { fileURLToPath } from "node:url";

import * as dotenv from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(here, "../../..");

dotenv.config({ path: path.join(repositoryRoot, ".env") });

const schema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(4100),
  CONSOLE_ORIGIN: z.string().default("http://localhost:5180"),
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.string().default("http://127.0.0.1:8645"),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  /** Blocks to stay behind the head. Zero on a network with immediate finality such as QBFT. */
  CONFIRMATIONS: z.coerce.number().int().min(0).default(0),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(750),
  /** Fee per unit of gas in wei. Zero on a permissioned network that charges no gas. */
  GAS_PRICE_WEI: z.coerce.bigint().min(0n).default(0n),
  DEPLOYMENT_FILE: z.string().optional(),
  CUSTODY_MNEMONIC: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SESSION_HOURS: z.coerce.number().positive().default(8),
  /** Passphrase given to the operators created by the seed script. */
  OPERATOR_PASSPHRASE: z.string().min(12),
  /** Lets the sign-in page list operator profiles. Keep it off outside a private environment. */
  OPERATOR_DIRECTORY: z.enum(["enabled", "disabled"]).default("disabled"),
  RECONCILIATION_MINUTES: z.coerce.number().positive().default(15),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid configuration. Run "pnpm setup" to create .env.\n${problems}`);
}

const env = parsed.data;

export const config = {
  environment: env.NODE_ENV,
  http: { host: env.API_HOST, port: env.API_PORT, consoleOrigin: env.CONSOLE_ORIGIN },
  databaseUrl: env.DATABASE_URL,
  chain: {
    rpcUrl: env.RPC_URL,
    id: env.CHAIN_ID,
    confirmations: env.CONFIRMATIONS,
    pollMs: env.INDEXER_POLL_MS,
    gasPriceWei: env.GAS_PRICE_WEI,
    deploymentFile:
      env.DEPLOYMENT_FILE ?? path.join(repositoryRoot, "contracts", "deployments", `${env.CHAIN_ID}.json`),
  },
  custody: { mnemonic: env.CUSTODY_MNEMONIC },
  auth: {
    jwtSecret: env.JWT_SECRET,
    sessionHours: env.SESSION_HOURS,
    operatorPassphrase: env.OPERATOR_PASSPHRASE,
    operatorDirectory: env.OPERATOR_DIRECTORY === "enabled",
  },
  reconciliationMinutes: env.RECONCILIATION_MINUTES,
  referenceNetworkFile: path.join(repositoryRoot, "network", "reference-network.json"),
} as const;

export type Config = typeof config;
