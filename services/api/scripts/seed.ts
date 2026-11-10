/**
 * Loads the operational data of the reference network: console operators, the custody key map and
 * the display details of accounts and merchants. Safe to run again; existing rows are updated.
 *
 *   pnpm --filter @takarail/api seed
 */
import fs from "node:fs";

import { hashPassphrase } from "../src/auth/passwords";
import { accountAt } from "../src/chain/custody";
import { config } from "../src/config";
import { migrate } from "../src/db/migrate";
import { pool, transaction } from "../src/db/pool";

interface ReferenceNetwork {
  officers: { username: string; displayName: string; role: string; institution: string | null; keyIndex: number }[];
  institutions: {
    id: string;
    name: string;
    adminIndex: number;
    settlementIndex: number;
    adminUsername: string;
    operatorRole: string;
  }[];
  accounts: { keyIndex: number; institution: string; label: string; district: string }[];
  merchants: { id: string; name: string; city: string }[];
}

const reference = JSON.parse(fs.readFileSync(config.referenceNetworkFile, "utf8")) as ReferenceNetwork;
const addressAt = (index: number) => accountAt(index).address.toLowerCase();

async function main(): Promise<void> {
  await migrate();
  const passwordHash = hashPassphrase(config.auth.operatorPassphrase);

  const operators = [
    ...reference.officers,
    ...reference.institutions
      .filter((institution) => !reference.officers.some((officer) => officer.username === institution.adminUsername))
      .map((institution) => ({
        username: institution.adminUsername,
        displayName: `${institution.name} (operations)`,
        role: institution.operatorRole,
        institution: institution.id,
        keyIndex: institution.adminIndex,
      })),
  ];

  await transaction(async (db) => {
    for (const operator of operators) {
      await db.query(
        `INSERT INTO operators (username, display_name, role, institution_id, address, key_index, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (username) DO UPDATE
           SET display_name = EXCLUDED.display_name, role = EXCLUDED.role,
               institution_id = EXCLUDED.institution_id, address = EXCLUDED.address,
               key_index = EXCLUDED.key_index, password_hash = EXCLUDED.password_hash`,
        [
          operator.username,
          operator.displayName,
          operator.role,
          operator.institution,
          addressAt(operator.keyIndex),
          operator.keyIndex,
          passwordHash,
        ],
      );
    }

    const wallets = [
      ...reference.institutions.map((institution) => ({
        keyIndex: institution.settlementIndex,
        institution: institution.id,
        label: `${institution.name} (settlement)`,
        district: null as string | null,
      })),
      ...reference.accounts,
    ];
    for (const wallet of wallets) {
      const address = addressAt(wallet.keyIndex);
      await db.query(
        `INSERT INTO custody_keys (address, key_index, institution_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (address) DO UPDATE SET key_index = EXCLUDED.key_index, institution_id = EXCLUDED.institution_id`,
        [address, wallet.keyIndex, wallet.institution],
      );
      await db.query(
        `INSERT INTO account_profiles (address, label, district)
         VALUES ($1, $2, $3)
         ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, district = EXCLUDED.district`,
        [address, wallet.label, wallet.district],
      );
    }

    for (const merchant of reference.merchants) {
      await db.query(
        `INSERT INTO merchant_profiles (id, name, city)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city`,
        [merchant.id, merchant.name, merchant.city],
      );
    }
  });

  console.log(
    `Loaded ${operators.length} operators, ${reference.accounts.length + reference.institutions.length} wallets ` +
      `and ${reference.merchants.length} merchant profiles`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
