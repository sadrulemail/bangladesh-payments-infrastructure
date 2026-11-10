# Operations guide

How to run, reset and extend a TakaRail environment.

## Requirements

- Node.js 22 or newer
- pnpm 10
- Docker, for PostgreSQL
- Chrome or Edge, only for `pnpm screens` and `pnpm diagrams`

## Configuration

`pnpm setup` creates `.env` from `.env.example` with generated secrets and leaves an existing `.env`
untouched.

| Variable                                             | Used by        | Meaning                                                                                         |
| ---------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `CHAIN_ID`, `RPC_URL`                                | Contracts, API | Chain to deploy to and follow                                                                   |
| `CHAIN_START_DAYS_AGO`                               | Local node     | Starts the node's clock in the past, so the scenario can replay a week and end at the present   |
| `GAS_PRICE_WEI`                                      | API            | Fee per unit of gas; zero on a permissioned network                                             |
| `CUSTODY_MNEMONIC`                                   | Contracts, API | BIP-39 mnemonic every operator and custodial wallet is derived from                             |
| `POSTGRES_PORT`, `POSTGRES_PASSWORD`, `DATABASE_URL` | Docker, API    | Database                                                                                        |
| `API_PORT`, `CONSOLE_ORIGIN`                         | API            | HTTP port and the origin allowed by CORS                                                        |
| `JWT_SECRET`                                         | API            | Signs sessions; at least 32 characters                                                          |
| `OPERATOR_PASSPHRASE`                                | Seed script    | Passphrase of the operators the seed creates                                                    |
| `OPERATOR_DIRECTORY`                                 | API            | `enabled` lets the sign-in page list profiles; keep it `disabled` outside a private environment |
| `CONFIRMATIONS`                                      | API            | Blocks the indexer stays behind the head; zero with immediate finality                          |
| `RECONCILIATION_MINUTES`                             | API            | Interval of the scheduled reconciliation                                                        |

Nothing secret is stored in the repository. `.env` and `contracts/deployments/` are ignored by git.

## Start

| Step | Command             | Result                                                                         |
| ---- | ------------------- | ------------------------------------------------------------------------------ |
| 1    | `pnpm install`      | Dependencies                                                                   |
| 2    | `pnpm setup`        | `.env` with fresh secrets; prints the operator passphrase                      |
| 3    | `pnpm db:up`        | PostgreSQL on port 5544                                                        |
| 4    | `pnpm chain`        | Local EVM node on port 8645 (keep it running)                                  |
| 5    | `pnpm deploy:local` | Contracts and the reference network; writes `contracts/deployments/31337.json` |
| 6    | `pnpm seed`         | Schema, operators, custody key map, display profiles                           |
| 7    | `pnpm api`          | API on port 4100, indexer and scheduled reconciliation                         |
| 8    | `pnpm scenario`     | A business week of activity, played through the API                            |
| 9    | `pnpm console`      | Console on port 5180                                                           |

The API applies pending migrations when it starts. Migrations are plain SQL files in
`services/api/src/db/migrations`, applied once, in file-name order.

## Reset

The local node keeps its state in memory, so a reset is: stop the node and the API, drop the database
volume, and start again from step 3.

```bash
docker compose down -v
```

The scenario plays once per deployment. It refuses to run on a chain that already carries supply.

## Rebuilding the read models

Read models and the ledger come only from contract events. To rebuild them without touching
operational data, stop the API, truncate the event-sourced tables and start it again; the indexer
replays the chain from the deployment block.

```sql
TRUNCATE indexer_cursor, chain_events, token_transfers, payments, refunds, remittances,
         reference_rates, corridor_originators, corridors, gateway_policy, reserve_statements,
         issuance_requests, redemption_requests, disbursement_payouts, disbursement_batches,
         merchants, category_fees, fee_schedule, tier_limits, accounts, institutions,
         journal_lines, journal_entries, reconciliation_runs CASCADE;
DELETE FROM ledger_accounts WHERE wallet IS NOT NULL;
```

`operators`, `custody_keys`, `account_profiles`, `merchant_profiles`, `disbursement_payout_lists` and
`audit_log` are kept.

## When reconciliation reports a mismatch

1. Open the run under **Ledger**; it lists each wallet whose ledger balance differs from the chain.
2. Compare `indexer_cursor.block_number` with the head of the chain. A stalled indexer shows as a
   growing gap, not as a mismatch: the run always compares both sides at the cursor block.
3. Look for the wallet's movements in `token_transfers` and `journal_entries` by transaction hash.
   Each transfer must have exactly one entry.
4. If an entry is missing, rebuild the read models as above and run reconciliation again.

A difference between supply and the reserve statement is a different matter: issuance stops by itself
when the statement is older than the configured age or smaller than supply plus the request.

## Extending the reference network

`network/reference-network.json` describes policy, officers, institutions, corridors, accounts and
merchants. The deployment script and the seed script both read it, so a new institution or corridor
is added in one place. Key indexes must be unique; indexes 0 to 99 are funded by the local node.

Accounts opened from the console take the next free key index and need no change to the file.

## Moving to a permissioned network

The contracts need nothing from the local node. A Hyperledger Besu network with QBFT fits the design:

- **Finality.** QBFT blocks are final, which is what `CONFIRMATIONS=0` assumes.
- **No gas fee.** Run validators with a zero minimum gas price and a zero base fee in the genesis
  file; `GAS_PRICE_WEI=0` is already the default of the API.
- **Permissioning.** Node and account permissioning at the network layer complements the registry.
- **Deployment.** Add the network to `contracts/hardhat.config.ts` and run the deploy script against
  it with a governance key held in a hardware wallet or a multi-signature contract.
- **Clock.** Leave `CHAIN_START_DAYS_AGO` unset. The scenario detects that it cannot move the clock
  and plays at the pace of the chain.

## Scripts

| Command                                   | Purpose                                                    |
| ----------------------------------------- | ---------------------------------------------------------- |
| `pnpm spec`                               | Contract and SDK specifications                            |
| `pnpm typecheck`                          | Strict TypeScript across all packages                      |
| `pnpm format` / `pnpm format:check`       | Prettier for TypeScript, JSON and Solidity                 |
| `pnpm --filter @takarail/contracts build` | Compiles the contracts and regenerates the ABIs in the SDK |
| `pnpm screens`                            | Captures the console screenshots into `docs/screenshots`   |
| `pnpm diagrams`                           | Renders `docs/diagrams/*.mmd` to light and dark images     |
