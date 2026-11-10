import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";

import path from "node:path";

import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

/** Wallets derived from the custody mnemonic: operators, institutions, merchants and customers. */
const ACCOUNT_COUNT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

const mnemonic = process.env.CUSTODY_MNEMONIC;
const derivedAccounts = mnemonic ? { mnemonic, count: ACCOUNT_COUNT } : { count: ACCOUNT_COUNT };

/**
 * The local node can start its clock in the past, so the reference scenario replays several
 * business days and finishes at the present.
 */
const startDaysAgo = Number(process.env.CHAIN_START_DAYS_AGO ?? 0);
const initialDate = startDaysAgo > 0 ? new Date(Date.now() - startDaysAgo * DAY_MS).toISOString() : undefined;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  paths: {
    sources: "./src",
  },
  networks: {
    hardhat: {
      chainId: Number(process.env.CHAIN_ID ?? 31337),
      accounts: derivedAccounts,
      // A permissioned network charges no gas: wallets transact without holding a native coin.
      initialBaseFeePerGas: 0,
      ...(initialDate ? { initialDate } : {}),
    },
    local: {
      url: process.env.RPC_URL ?? "http://127.0.0.1:8645",
      chainId: Number(process.env.CHAIN_ID ?? 31337),
      accounts: mnemonic ? { mnemonic, count: ACCOUNT_COUNT } : "remote",
    },
  },
  mocha: {
    timeout: 60_000,
  },
};

export default config;
