/** Retail payments through the payment switch: merchant payments, transfers and refunds. */
import { decodeMerchantQr, instructions, parseTaka } from "@takarail/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { signerOfWallet } from "../chain/custody";
import { contracts } from "../chain/network";
import { pool, query, queryOne } from "../db/pool";
import { execute } from "../http/commands";
import { route } from "../http/route";
import { address, idParams, pagination, purposeCode, reference, shortCode, takaAmount } from "../http/schemas";
import { badRequest, notFound } from "../lib/errors";

const merchantPayment = z
  .object({
    payer: address,
    /** Payload of the scanned QR code. Carries the merchant and, on a dynamic code, the amount. */
    qrPayload: z.string().trim().min(20).max(512).optional(),
    merchantId: shortCode.optional(),
    amount: takaAmount.optional(),
    invoiceRef: reference.max(25).optional(),
  })
  .refine((value) => value.qrPayload !== undefined || value.merchantId !== undefined, {
    message: "Provide a QR payload or a merchant id",
  });

/** Merchant, amount and invoice of a payment, taken from the QR code when one was scanned. */
function resolvePayment(body: z.infer<typeof merchantPayment>) {
  const code = body.qrPayload === undefined ? undefined : decodeMerchantQr(body.qrPayload);
  const merchantId = code?.merchantId ?? body.merchantId;
  const amount = code?.amount === undefined ? body.amount : parseTaka(code.amount);
  if (merchantId === undefined) throw badRequest("The payment names no merchant");
  if (amount === undefined) throw badRequest("An amount is required for a static QR code");
  return { merchantId, amount, invoiceRef: code?.invoiceRef ?? body.invoiceRef ?? "" };
}

export function paymentRoutes(app: FastifyInstance): void {
  route(app, {
    method: "GET",
    url: "/v1/payments",
    tag: "Payments",
    summary: "Settled payments, most recent first",
    access: "operator",
    query: pagination.extend({
      kind: z.enum(["merchant", "person"]).optional(),
      merchant: shortCode.optional(),
    }),
    handler: async ({ query: filter }) =>
      query(
        pool,
        `SELECT p.id, p.kind, p.payer, payer.label AS payer_label, pa.institution_id AS payer_institution,
                p.payee, COALESCE(mp.name, payee.label) AS payee_label, pb.institution_id AS payee_institution,
                p.merchant_id, p.amount, p.acquirer_fee, p.network_fee, p.refunded, p.reference, p.purpose,
                p.settled_at, p.tx_hash
           FROM payments p
           LEFT JOIN account_profiles payer ON payer.address = p.payer
           LEFT JOIN account_profiles payee ON payee.address = p.payee
           LEFT JOIN merchant_profiles mp ON mp.id = p.merchant_id
           LEFT JOIN accounts pa ON pa.address = p.payer
           LEFT JOIN accounts pb ON pb.address = p.payee
          WHERE ($1::text IS NULL OR p.kind = $1)
            AND ($2::text IS NULL OR p.merchant_id = $2)
          ORDER BY p.id DESC
          LIMIT $3 OFFSET $4`,
        [filter.kind ?? null, filter.merchant ?? null, filter.limit, filter.offset],
      ),
  });

  route(app, {
    method: "POST",
    url: "/v1/payments/merchant",
    tag: "Payments",
    summary: "Pay a merchant from a customer wallet, from a scanned QR code or a merchant id",
    access: ["institution_admin"],
    body: merchantPayment,
    handler: async ({ body, operator }) => {
      const payment = resolvePayment(body);
      return execute(
        operator,
        "payment.merchant",
        { payer: body.payer, ...payment },
        await signerOfWallet(operator, body.payer),
        {
          ...contracts.token,
          functionName: "transferAndCall",
          args: [
            contracts.paymentSwitch.address,
            payment.amount,
            instructions.merchantPayment(payment.merchantId, payment.invoiceRef),
          ],
        },
      );
    },
  });

  route(app, {
    method: "POST",
    url: "/v1/payments/transfer",
    tag: "Payments",
    summary: "Transfer between two people, at the same institution or across institutions",
    access: ["institution_admin"],
    body: z.object({
      payer: address,
      payee: address,
      amount: takaAmount,
      reference: reference,
      purpose: purposeCode.default("FAMI"),
    }),
    handler: async ({ body, operator }) =>
      execute(operator, "payment.transfer", body, await signerOfWallet(operator, body.payer), {
        ...contracts.token,
        functionName: "transferAndCall",
        args: [
          contracts.paymentSwitch.address,
          body.amount,
          instructions.personTransfer(body.payee, body.reference, body.purpose),
        ],
      }),
  });

  route(app, {
    method: "POST",
    url: "/v1/payments/:id/refund",
    tag: "Payments",
    summary: "Refund all or part of a merchant payment from the merchant's wallet",
    access: ["institution_admin"],
    params: idParams,
    body: z.object({ amount: takaAmount }),
    handler: async ({ params, body, operator }) => {
      const payment = await queryOne<{ payee: string; kind: string }>(
        pool,
        "SELECT payee, kind FROM payments WHERE id = $1",
        [params.id],
      );
      if (!payment) throw notFound(`Payment ${params.id}`);
      if (payment.kind !== "merchant") throw badRequest("Only merchant payments can be refunded");

      return execute(
        operator,
        "payment.refund",
        { paymentId: params.id, amount: body.amount },
        await signerOfWallet(operator, payment.payee),
        {
          ...contracts.token,
          functionName: "transferAndCall",
          args: [contracts.paymentSwitch.address, body.amount, instructions.refund(params.id)],
        },
      );
    },
  });
}
