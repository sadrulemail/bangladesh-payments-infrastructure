import { ACCOUNT_STATUSES, INSTITUTION_KINDS, TIERS, enumName, fromAscii, fromCode } from "@takarail/sdk";
import type { Address, Hex } from "viem";

import { type Projection, type ProjectionMap, lower } from "../types";

const institutionRegistered: Projection<{
  id: Hex;
  kind: number;
  name: string;
  country: Hex;
  admin: Address;
  settlementAccount: Address;
}> = async (db, { args, blockTime }) => {
  await db.query(
    `INSERT INTO institutions (id, kind, name, country, admin_address, settlement_account, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      fromCode(args.id),
      enumName(INSTITUTION_KINDS, args.kind),
      args.name,
      fromAscii(args.country),
      lower(args.admin),
      lower(args.settlementAccount),
      blockTime,
    ],
  );
};

const institutionStatusChanged: Projection<{ id: Hex; active: boolean }> = async (db, { args }) => {
  await db.query("UPDATE institutions SET active = $2 WHERE id = $1", [fromCode(args.id), args.active]);
};

const institutionAdminChanged: Projection<{ id: Hex; newAdmin: Address }> = async (db, { args }) => {
  await db.query("UPDATE institutions SET admin_address = $2 WHERE id = $1", [fromCode(args.id), lower(args.newAdmin)]);
};

const accountOpened: Projection<{ holder: Address; institution: Hex; tier: number; identityRef: Hex }> = async (
  db,
  { args, blockTime },
) => {
  await db.query(
    `INSERT INTO accounts (address, institution_id, tier, status, identity_ref, opened_at)
     VALUES ($1, $2, $3, 'Active', $4, $5)`,
    [lower(args.holder), fromCode(args.institution), enumName(TIERS, args.tier), args.identityRef, blockTime],
  );
};

const accountTierChanged: Projection<{ holder: Address; newTier: number }> = async (db, { args }) => {
  await db.query("UPDATE accounts SET tier = $2 WHERE address = $1", [
    lower(args.holder),
    enumName(TIERS, args.newTier),
  ]);
};

const accountStatusChanged: Projection<{ holder: Address; status: number; reason: Hex }> = async (db, { args }) => {
  await db.query("UPDATE accounts SET status = $2, status_reason = $3 WHERE address = $1", [
    lower(args.holder),
    enumName(ACCOUNT_STATUSES, args.status),
    fromCode(args.reason) || null,
  ]);
};

const tierLimitsUpdated: Projection<{
  tier: number;
  perTransaction: bigint;
  dailyOutflow: bigint;
  maxBalance: bigint;
}> = async (db, { args }) => {
  await db.query(
    `INSERT INTO tier_limits (tier, per_transaction, daily_outflow, max_balance)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tier) DO UPDATE
       SET per_transaction = EXCLUDED.per_transaction,
           daily_outflow   = EXCLUDED.daily_outflow,
           max_balance     = EXCLUDED.max_balance`,
    [enumName(TIERS, args.tier), args.perTransaction, args.dailyOutflow, args.maxBalance],
  );
};

export const registryProjections = {
  InstitutionRegistered: institutionRegistered,
  InstitutionStatusChanged: institutionStatusChanged,
  InstitutionAdminChanged: institutionAdminChanged,
  AccountOpened: accountOpened,
  AccountTierChanged: accountTierChanged,
  AccountStatusChanged: accountStatusChanged,
  TierLimitsUpdated: tierLimitsUpdated,
} as ProjectionMap;
