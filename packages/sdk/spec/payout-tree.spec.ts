import assert from "node:assert/strict";

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Address } from "viem";

import { instructions } from "../src/instructions";
import { type PayoutEntry, buildPayoutTree } from "../src/payout-tree";

const wallet = (seed: number) => `0x${seed.toString(16).padStart(40, "0")}` as Address;

const PAYROLL: PayoutEntry[] = [
  { index: 0, account: wallet(1), amount: 1_250_000n },
  { index: 1, account: wallet(2), amount: 1_410_000n },
  { index: 2, account: wallet(3), amount: 1_680_000n },
];

describe("payout tree", () => {
  it("commits to the payout list with a root, a total and a count", () => {
    const tree = buildPayoutTree(PAYROLL);

    assert.match(tree.root, /^0x[0-9a-f]{64}$/);
    assert.equal(tree.total, 4_340_000n);
    assert.equal(tree.count, 3);
  });

  it("produces a proof for every payout", () => {
    const tree = buildPayoutTree(PAYROLL);

    for (const entry of PAYROLL) {
      const leaf = [entry.index, entry.account, entry.amount];
      const proof = tree.proofFor(entry.index);
      assert.ok(StandardMerkleTree.verify(tree.root, ["uint32", "address", "uint128"], leaf, proof));
    }
  });

  it("changes the root when a single amount changes", () => {
    const edited = PAYROLL.map((entry) => (entry.index === 1 ? { ...entry, amount: entry.amount + 1n } : entry));

    assert.notEqual(buildPayoutTree(edited).root, buildPayoutTree(PAYROLL).root);
  });

  it("refuses an empty list, a gap in the indexes and an empty amount", () => {
    assert.throws(() => buildPayoutTree([]), RangeError);
    assert.throws(() => buildPayoutTree([{ ...PAYROLL[0]!, index: 1 }]), RangeError);
    assert.throws(() => buildPayoutTree([{ ...PAYROLL[0]!, amount: 0n }]), RangeError);
  });

  it("feeds the batch instruction", () => {
    const tree = buildPayoutTree(PAYROLL);
    const instruction = instructions.disbursementBatch({
      batchRef: "PAYROLL-2026-11",
      merkleRoot: tree.root,
      count: tree.count,
      purpose: "SALA",
    });

    assert.equal(instruction.length, 2 + 4 * 64);
    assert.ok(instruction.includes(tree.root.slice(2)));
  });
});
