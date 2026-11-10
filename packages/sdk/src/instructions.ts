/**
 * Instruction encoders. A holder funds a settlement module with `transferAndCall(module, amount,
 * instruction)`; these builders produce the `instruction` bytes each module expects. They mirror the
 * `encode*` view functions of the contracts.
 */
import { type Address, type Hex, encodeAbiParameters } from "viem";

import { toAscii, toCode, toReference } from "./codes";
import type { PurposeCode } from "./domain";

const PAYMENT_SWITCH = { merchantPayment: 1, personTransfer: 2, refund: 3 } as const;
const REMITTANCE_GATEWAY = { remittance: 1, incentiveFunding: 2 } as const;

const envelope = (kind: number, payload: Hex): Hex =>
  encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [kind, payload]);

export interface RemittanceInstruction {
  corridor: string;
  beneficiary: Address;
  /** Amount collected abroad, in minor units of the corridor currency. */
  sourceAmount: bigint;
  /** Rate given to the customer, scaled by one million. */
  quotedRate: bigint;
  purpose: PurposeCode;
  /** Originator's own reference; accepted once. */
  senderRef: string;
}

export interface BatchInstruction {
  /** Payer's own reference; accepted once per payer. */
  batchRef: string;
  merkleRoot: Hex;
  count: number;
  purpose: PurposeCode;
}

export const instructions = {
  /** Pays a merchant. A non-empty `invoiceRef` can be paid only once. */
  merchantPayment(merchantId: string, invoiceRef = ""): Hex {
    const payload = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [toCode(merchantId), toReference(invoiceRef)],
    );
    return envelope(PAYMENT_SWITCH.merchantPayment, payload);
  },

  /** Transfers to another person with an end-to-end reference and a purpose. */
  personTransfer(payee: Address, endToEndRef: string, purpose: PurposeCode): Hex {
    const payload = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes4" }],
      [payee, toReference(endToEndRef), toAscii(purpose, 4)],
    );
    return envelope(PAYMENT_SWITCH.personTransfer, payload);
  },

  /** Refunds all or part of a merchant payment; sent by the merchant. */
  refund(paymentId: bigint): Hex {
    return envelope(PAYMENT_SWITCH.refund, encodeAbiParameters([{ type: "uint256" }], [paymentId]));
  },

  /** Originates an inward remittance; sent by an exchange house. */
  remittance(instruction: RemittanceInstruction): Hex {
    const payload = encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "bytes4" },
        { type: "bytes32" },
      ],
      [
        toCode(instruction.corridor),
        instruction.beneficiary,
        instruction.sourceAmount,
        instruction.quotedRate,
        toAscii(instruction.purpose, 4),
        toReference(instruction.senderRef),
      ],
    );
    return envelope(REMITTANCE_GATEWAY.remittance, payload);
  },

  /** Adds the transferred amount to the remittance incentive pool. */
  incentiveFunding(): Hex {
    return envelope(REMITTANCE_GATEWAY.incentiveFunding, "0x");
  },

  /** Opens a redemption request; sent by an institution's settlement account. */
  redemption(payoutRef: string): Hex {
    return encodeAbiParameters([{ type: "bytes32" }], [toReference(payoutRef)]);
  },

  /** Creates a disbursement batch funded with the transferred amount. */
  disbursementBatch(instruction: BatchInstruction): Hex {
    return encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes4" }],
      [toReference(instruction.batchRef), instruction.merkleRoot, instruction.count, toAscii(instruction.purpose, 4)],
    );
  },
};
