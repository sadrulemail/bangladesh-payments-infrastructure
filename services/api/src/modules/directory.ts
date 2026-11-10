/** Institutions, accounts, merchants and the policy that applies to them. */
import {
  CUSTOMER_TIERS,
  MERCHANT_CATEGORIES,
  QrFormatError,
  TIERS,
  decodeMerchantQr,
  encodeMerchantQr,
  enumValue,
  formatDecimal,
  toReference,
} from "@takarail/sdk";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { type Address, keccak256, stringToHex } from "viem";
import { z } from "zod";

import { type Operator, allocateWallet, settlementSignerOf, signerOfOperator, signerOfWallet } from "../chain/custody";
import { contracts, publicClient } from "../chain/network";
import { pool, query, queryOne, transaction } from "../db/pool";
import { execute } from "../http/commands";
import { route } from "../http/route";
import { addressParams, pagination, reference, shortCode, takaAmount } from "../http/schemas";
import { badRequest, forbidden, notFound } from "../lib/errors";

interface AccountRow {
  address: string;
  institutionId: string;
  tier: string;
  status: string;
}

const ACCOUNT_SELECT = `
  SELECT a.address, a.institution_id, i.name AS institution_name, a.tier, a.status, a.status_reason,
         a.opened_at, p.label, p.district, COALESCE(b.balance, 0)::bigint AS balance,
         (k.address IS NOT NULL) AS in_custody
    FROM accounts a
    JOIN institutions i ON i.id = a.institution_id
    LEFT JOIN account_profiles p ON p.address = a.address
    LEFT JOIN ledger_balances b ON b.wallet = a.address
    LEFT JOIN custody_keys k ON k.address = a.address`;

async function requireAccount(wallet: string): Promise<AccountRow> {
  const account = await queryOne<AccountRow>(
    pool,
    "SELECT address, institution_id, tier, status FROM accounts WHERE address = $1",
    [wallet],
  );
  if (!account) throw notFound(`Account ${wallet}`);
  return account;
}

/** An institution administrator acts on its own customers; the supervisor on any account. */
function requireControl(operator: Operator, account: AccountRow): void {
  if (operator.role !== "supervisor" && operator.institutionId !== account.institutionId) {
    throw forbidden("This account is sponsored by another institution");
  }
}

export function directoryRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/institutions",
    tag: "Directory",
    summary: "Member institutions with their settlement balance",
    access: "operator",
    handler: async () =>
      query(
        pool,
        `SELECT i.id, i.kind, i.name, i.country, i.active, i.settlement_account, i.registered_at,
                COALESCE(b.balance, 0)::bigint AS settlement_balance,
                (SELECT COUNT(*) FROM accounts a
                  WHERE a.institution_id = i.id AND a.tier NOT IN ('Institution', 'System'))::int AS customer_accounts,
                (SELECT COALESCE(SUM(lb.balance), 0) FROM accounts a
                   JOIN ledger_balances lb ON lb.wallet = a.address
                  WHERE a.institution_id = i.id AND a.tier NOT IN ('Institution', 'System'))::bigint AS customer_balances
           FROM institutions i
           LEFT JOIN ledger_balances b ON b.wallet = i.settlement_account
          ORDER BY i.registered_at, i.id`,
      ),
  });

  route(app, {
    method: "GET",
    url: "/v1/accounts",
    tag: "Directory",
    summary: "Accounts with their ledger balance",
    access: "operator",
    query: pagination.extend({
      institution: shortCode.optional(),
      tier: z.enum(TIERS).optional(),
      status: z.enum(["Active", "Frozen", "Closed"]).optional(),
      search: z.string().trim().max(64).optional(),
    }),
    handler: async ({ query: filter }) =>
      query(
        pool,
        `${ACCOUNT_SELECT}
          WHERE a.tier <> 'System'
            AND ($1::text IS NULL OR a.institution_id = $1)
            AND ($2::text IS NULL OR a.tier = $2)
            AND ($3::text IS NULL OR a.status = $3)
            AND ($4::text IS NULL OR p.label ILIKE '%' || $4 || '%' OR a.address ILIKE '%' || $4 || '%')
          ORDER BY (a.tier = 'Institution') DESC, p.label NULLS LAST, a.address
          LIMIT $5 OFFSET $6`,
        [
          filter.institution ?? null,
          filter.tier ?? null,
          filter.status ?? null,
          filter.search ?? null,
          filter.limit,
          filter.offset,
        ],
      ),
  });

  route(app, {
    method: "GET",
    url: "/v1/accounts/:address",
    tag: "Directory",
    summary: "One account with its live balance, limits and recent movements",
    access: "operator",
    params: addressParams,
    handler: async ({ params }) => {
      const account = await queryOne(pool, `${ACCOUNT_SELECT} WHERE a.address = $1`, [params.address]);
      if (!account) throw notFound(`Account ${params.address}`);

      const [balance, spentToday, limits, movements] = await Promise.all([
        publicClient.readContract({ ...contracts.token, functionName: "balanceOf", args: [params.address] }),
        publicClient.readContract({ ...contracts.token, functionName: "spentToday", args: [params.address] }),
        queryOne(pool, "SELECT per_transaction, daily_outflow, max_balance FROM tier_limits WHERE tier = $1", [
          (account as { tier: string }).tier,
        ]),
        query(
          pool,
          `SELECT t.block_time, t.tx_hash, t.amount,
                  (t.to_address = $1) AS incoming,
                  CASE WHEN t.to_address = $1 THEN t.from_address ELSE t.to_address END AS counterparty,
                  cp.label AS counterparty_label
             FROM token_transfers t
             LEFT JOIN account_profiles cp
               ON cp.address = CASE WHEN t.to_address = $1 THEN t.from_address ELSE t.to_address END
            WHERE t.from_address = $1 OR t.to_address = $1
            ORDER BY t.id DESC
            LIMIT 25`,
          [params.address],
        ),
      ]);
      return { ...account, chainBalance: balance, spentToday, limits: limits ?? null, movements };
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/accounts",
    tag: "Directory",
    summary: "Open a customer account in a new custodial wallet",
    access: ["institution_admin"],
    body: z.object({
      label: z.string().trim().min(2).max(80),
      district: z.string().trim().min(2).max(40),
      tier: z.enum(CUSTOMER_TIERS),
      /** Reference of the KYC file in the institution's own records. Only its hash goes on chain. */
      kycReference: reference,
    }),
    handler: async ({ body, operator }) => {
      const institutionId = operator.institutionId;
      if (!institutionId) throw forbidden("Your profile is not attached to an institution");

      const wallet = await transaction(async (db) => {
        const account = await allocateWallet(db, institutionId);
        await db.query("INSERT INTO account_profiles (address, label, district) VALUES ($1, $2, $3)", [
          account.address.toLowerCase(),
          body.label,
          body.district,
        ]);
        return account.address;
      });

      const identityRef = keccak256(stringToHex(`${institutionId}:${body.kycReference}`));
      const result = await execute(
        operator,
        "account.open",
        { wallet, tier: body.tier, label: body.label },
        signerOfOperator(operator),
        {
          ...contracts.registry,
          functionName: "openAccount",
          args: [wallet, enumValue(TIERS, body.tier), identityRef],
        },
      );
      return { ...result, address: wallet.toLowerCase() };
    },
  });

  for (const action of ["freeze", "unfreeze"] as const) {
    route(app, {
      method: "POST",
      url: `/v1/accounts/:address/${action}`,
      tag: "Directory",
      summary: action === "freeze" ? "Freeze an account" : "Lift the freeze on an account",
      access: ["institution_admin", "supervisor"],
      params: addressParams,
      body: z.object({ reason: reference.optional() }),
      handler: async ({ params, body, operator }) => {
        requireControl(operator, await requireAccount(params.address));
        const signer = signerOfOperator(operator);
        if (action === "unfreeze") {
          return execute(operator, "account.unfreeze", { wallet: params.address }, signer, {
            ...contracts.registry,
            functionName: "unfreezeAccount",
            args: [params.address],
          });
        }
        if (!body.reason) throw badRequest("A case reference is required to freeze an account");
        return execute(operator, "account.freeze", { wallet: params.address, reason: body.reason }, signer, {
          ...contracts.registry,
          functionName: "freezeAccount",
          args: [params.address, toReference(body.reason)],
        });
      },
    });
  }

  for (const direction of ["cash-in", "cash-out"] as const) {
    route(app, {
      method: "POST",
      url: `/v1/accounts/:address/${direction}`,
      tag: "Directory",
      summary:
        direction === "cash-in"
          ? "Credit a customer wallet from the institution's settlement account"
          : "Return funds from a customer wallet to the institution's settlement account",
      access: ["institution_admin"],
      params: addressParams,
      body: z.object({ amount: takaAmount }),
      handler: async ({ params, body, operator }) => {
        const account = await requireAccount(params.address);
        requireControl(operator, account);
        const settlement = await settlementSignerOf(operator);
        const [signer, to]: [typeof settlement, Address] =
          direction === "cash-in"
            ? [settlement, params.address]
            : [await signerOfWallet(operator, params.address), settlement.address];
        return execute(operator, `account.${direction}`, { wallet: params.address, amount: body.amount }, signer, {
          ...contracts.token,
          functionName: "transfer",
          args: [to, body.amount],
        });
      },
    });
  }

  route(app, {
    method: "GET",
    url: "/v1/merchants",
    tag: "Directory",
    summary: "Merchants with their fee and settled volume",
    access: "operator",
    handler: async () => {
      const merchants = await query<{ categoryCode: number }>(
        pool,
        `SELECT m.id, m.acquirer_id, i.name AS acquirer_name, m.account, m.category_code, m.active,
                COALESCE(mp.name, m.id) AS name, mp.city,
                COALESCE(cf.fee_bps, fs.default_fee_bps) AS fee_bps,
                COALESCE(b.balance, 0)::bigint AS balance,
                COUNT(p.id)::int AS payments,
                COALESCE(SUM(p.amount), 0)::bigint AS volume
           FROM merchants m
           JOIN institutions i ON i.id = m.acquirer_id
           CROSS JOIN fee_schedule fs
           LEFT JOIN merchant_profiles mp ON mp.id = m.id
           LEFT JOIN category_fees cf ON cf.category_code = m.category_code
           LEFT JOIN ledger_balances b ON b.wallet = m.account
           LEFT JOIN payments p ON p.merchant_id = m.id
          GROUP BY m.id, i.name, mp.name, mp.city, cf.fee_bps, fs.default_fee_bps, b.balance
          ORDER BY name`,
      );
      return merchants.map((merchant) => ({
        ...merchant,
        category: MERCHANT_CATEGORIES[merchant.categoryCode] ?? `MCC ${merchant.categoryCode}`,
      }));
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/merchants/:id/qr",
    tag: "Directory",
    summary: "Build the Bangla QR payload and image of a merchant, static or for one invoice",
    access: "operator",
    params: z.object({ id: shortCode }),
    body: z.object({ amount: takaAmount.optional(), invoiceRef: reference.max(25).optional() }),
    handler: async ({ params, body }) => {
      const merchant = await queryOne<{
        id: string;
        acquirerId: string;
        categoryCode: number;
        name: string;
        city: string;
      }>(
        pool,
        `SELECT m.id, m.acquirer_id, m.category_code, COALESCE(mp.name, m.id) AS name, COALESCE(mp.city, 'Dhaka') AS city
           FROM merchants m
           LEFT JOIN merchant_profiles mp ON mp.id = m.id
          WHERE m.id = $1`,
        [params.id],
      );
      if (!merchant) throw notFound(`Merchant ${params.id}`);

      const payload = encodeMerchantQr({
        merchantId: merchant.id,
        acquirer: merchant.acquirerId,
        merchantName: merchant.name.slice(0, 25),
        merchantCity: merchant.city.slice(0, 15),
        categoryCode: merchant.categoryCode,
        amount: body.amount === undefined ? undefined : formatDecimal(body.amount, 2),
        invoiceRef: body.invoiceRef,
      });
      const svg = await QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
      return { payload, svg };
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/qr/decode",
    tag: "Directory",
    summary: "Read a Bangla QR payload and resolve its merchant",
    access: "operator",
    body: z.object({ payload: z.string().trim().min(20).max(512) }),
    handler: async ({ body }) => {
      try {
        const code = decodeMerchantQr(body.payload);
        const merchant = await queryOne(pool, "SELECT id, active, acquirer_id FROM merchants WHERE id = $1", [
          code.merchantId,
        ]);
        return { ...code, registered: merchant !== undefined, merchant: merchant ?? null };
      } catch (error) {
        if (error instanceof QrFormatError) throw badRequest(error.message);
        throw error;
      }
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/policy",
    tag: "Directory",
    summary: "Limits, fees and remittance policy in force",
    access: "operator",
    handler: async () => {
      const [tierLimits, feeSchedule, categoryFees, gateway] = await Promise.all([
        query(pool, "SELECT tier, per_transaction, daily_outflow, max_balance FROM tier_limits ORDER BY tier"),
        queryOne(pool, "SELECT default_fee_bps, acquirer_share_bps FROM fee_schedule WHERE id = 1"),
        query<{ categoryCode: number }>(
          pool,
          "SELECT category_code, fee_bps FROM category_fees ORDER BY category_code",
        ),
        queryOne(
          pool,
          `SELECT incentive_bps, rate_band_bps, rate_validity, review_window, screening_threshold, incentive_pool
             FROM gateway_policy WHERE id = 1`,
        ),
      ]);
      return {
        tierLimits,
        feeSchedule: feeSchedule ?? null,
        categoryFees: categoryFees.map((fee) => ({
          ...fee,
          category: MERCHANT_CATEGORIES[fee.categoryCode] ?? `MCC ${fee.categoryCode}`,
        })),
        gateway: gateway ?? null,
      };
    },
  });
}
