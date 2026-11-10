/**
 * Merkle commitment to the payout list of a disbursement batch. The leaf encoding matches
 * `DisbursementHub`: `(uint32 index, address account, uint128 amount)`, double hashed.
 */
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Address, Hex } from "viem";

export interface PayoutEntry {
  index: number;
  account: Address;
  /** Amount in poisha. */
  amount: bigint;
}

export interface PayoutTree {
  root: Hex;
  total: bigint;
  count: number;
  proofFor(index: number): Hex[];
}

const LEAF_ENCODING = ["uint32", "address", "uint128"];

export function buildPayoutTree(entries: readonly PayoutEntry[]): PayoutTree {
  if (entries.length === 0) throw new RangeError("A batch needs at least one payout");
  entries.forEach((entry, position) => {
    if (entry.index !== position) throw new RangeError(`Payout at position ${position} has index ${entry.index}`);
    if (entry.amount <= 0n) throw new RangeError(`Payout ${entry.index} has no amount`);
  });

  const tree = StandardMerkleTree.of(
    entries.map((entry) => [entry.index, entry.account, entry.amount]),
    LEAF_ENCODING,
  );
  return {
    root: tree.root as Hex,
    total: entries.reduce((sum, entry) => sum + entry.amount, 0n),
    count: entries.length,
    proofFor: (index) => tree.getProof(index) as Hex[],
  };
}
