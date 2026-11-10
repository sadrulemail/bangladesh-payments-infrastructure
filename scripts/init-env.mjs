/**
 * Creates `.env` with fresh secrets for a private environment: the custody mnemonic, the database
 * password, the session secret and the passphrase of the console operators. Nothing secret is kept
 * in the repository. An existing `.env` is left untouched.
 *
 *   pnpm setup
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { english, generateMnemonic } from "viem/accounts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".env");

if (fs.existsSync(target)) {
  console.log(".env already exists; nothing was changed.");
  process.exit(0);
}

const secret = (bytes) => randomBytes(bytes).toString("hex");
const databasePassword = secret(16);
const operatorPassphrase = generateMnemonic(english).split(" ").slice(0, 4).join("-");

const values = {
  CHAIN_ID: "31337",
  RPC_URL: "http://127.0.0.1:8645",
  CHAIN_START_DAYS_AGO: "7",
  GAS_PRICE_WEI: "0",
  CUSTODY_MNEMONIC: `"${generateMnemonic(english)}"`,
  POSTGRES_PORT: "5544",
  POSTGRES_PASSWORD: databasePassword,
  DATABASE_URL: `postgres://takarail:${databasePassword}@127.0.0.1:5544/takarail`,
  API_PORT: "4100",
  CONSOLE_ORIGIN: "http://localhost:5180",
  JWT_SECRET: secret(32),
  OPERATOR_PASSPHRASE: operatorPassphrase,
  OPERATOR_DIRECTORY: "enabled",
};

const template = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const content = template.replace(/^([A-Z_]+)=.*$/gm, (line, key) => (key in values ? `${key}=${values[key]}` : line));
fs.writeFileSync(target, content, { mode: 0o600 });

console.log("Created .env");
console.log(`Console operators sign in with the passphrase: ${operatorPassphrase}`);
