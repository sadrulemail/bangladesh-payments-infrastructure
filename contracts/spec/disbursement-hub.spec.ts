import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { expect } from "chai";
import { ethers } from "hardhat";

import { DAY, as, ascii, code, deployNetwork, taka } from "./support/network";

enum Status {
  None,
  AwaitingApproval,
  Approved,
  Rejected,
  Closed,
}

const SALARY = ascii("SALA");
const WAGE = taka(12_500);

type Leaf = [number, string, bigint];

/** Payout list of a batch together with the Merkle tree that commits to it. */
function payroll(accounts: string[], amount = WAGE) {
  const leaves: Leaf[] = accounts.map((account, index) => [index, account, amount]);
  const tree = StandardMerkleTree.of(leaves, ["uint32", "address", "uint128"]);
  const payouts = (indexes: number[]) =>
    indexes.map((index) => ({
      index,
      account: leaves[index][1],
      amount: leaves[index][2],
      proof: tree.getProof(index),
    }));
  const total = leaves.reduce((sum, leaf) => sum + leaf[2], 0n);
  return { tree, payouts, total, count: leaves.length };
}

describe("DisbursementHub", () => {
  /** The garment factory funds its November payroll for ten workers. */
  async function fundedBatch() {
    const network = await loadFixture(deployNetwork);
    const { hub, factory, workers, instruct } = network;
    const batch = payroll(workers.map((worker) => worker.address));
    const batchId: bigint = await hub.batchCount();
    const batchRef = ethers.id("PAYROLL-2026-11");
    await instruct(factory, hub, batch.total, await hub.encodeBatch(batchRef, batch.tree.root, batch.count, SALARY));
    return { ...network, batch, batchId, batchRef };
  }

  async function approvedBatch() {
    const context = await fundedBatch();
    await as(context.hub, context.surmaAdmin).approve(context.batchId);
    return context;
  }

  describe("funding", () => {
    it("escrows the batch total and commits to the payout list", async () => {
      const network = await loadFixture(deployNetwork);
      const { hub, token, factory, workers, instruct } = network;
      const batch = payroll(workers.map((worker) => worker.address));
      const batchRef = ethers.id("PAYROLL-2026-11");
      const instruction = await hub.encodeBatch(batchRef, batch.tree.root, batch.count, SALARY);

      const funding = instruct(factory, hub, batch.total, instruction);
      await expect(funding).to.changeTokenBalances(token, [factory, hub], [-batch.total, batch.total]);
      await expect(funding)
        .to.emit(hub, "BatchCreated")
        .withArgs(0n, factory.address, code("SURMA"), batchRef, batch.tree.root, batch.total, batch.count, SALARY);

      const record = await hub.batch(0);
      expect(record.status).to.equal(Status.AwaitingApproval);
      expect(record.total).to.equal(taka(125_000));
    });

    it("accepts batches from corporate and institution accounts only, once per reference", async () => {
      const { hub, factory, karim, batch, batchRef, instruct } = await fundedBatch();
      const instruction = await hub.encodeBatch(batchRef, batch.tree.root, batch.count, SALARY);

      await expect(instruct(karim, hub, taka(1_000), instruction))
        .to.be.revertedWithCustomError(hub, "PayerNotEligible")
        .withArgs(karim.address);
      await expect(instruct(factory, hub, batch.total, instruction))
        .to.be.revertedWithCustomError(hub, "DuplicateBatchRef")
        .withArgs(batchRef);
      await expect(
        instruct(factory, hub, batch.total, await hub.encodeBatch(ethers.id("EMPTY"), batch.tree.root, 0, SALARY)),
      ).to.be.revertedWithCustomError(hub, "InvalidBatch");
    });
  });

  describe("approval", () => {
    it("is given by the payer's bank", async () => {
      const { hub, surmaAdmin, sanguAdmin, factory, batchId } = await fundedBatch();

      await expect(as(hub, sanguAdmin).approve(batchId))
        .to.be.revertedWithCustomError(hub, "NotAuthorised")
        .withArgs(sanguAdmin.address);
      await expect(as(hub, factory).approve(batchId))
        .to.be.revertedWithCustomError(hub, "NotInstitutionAdmin")
        .withArgs(factory.address);

      await expect(as(hub, surmaAdmin).approve(batchId))
        .to.emit(hub, "BatchApproved")
        .withArgs(batchId, surmaAdmin.address);
      expect((await hub.batch(batchId)).status).to.equal(Status.Approved);
      await expect(as(hub, surmaAdmin).approve(batchId))
        .to.be.revertedWithCustomError(hub, "InvalidStatus")
        .withArgs(batchId, Status.Approved);
    });

    it("returns the funds when the bank rejects the batch", async () => {
      const { hub, token, surmaAdmin, factory, batch, batchId } = await fundedBatch();
      const reason = ethers.id("payer-mandate-expired");

      const rejection = as(hub, surmaAdmin).reject(batchId, reason);
      await expect(rejection).to.changeTokenBalances(token, [hub, factory], [-batch.total, batch.total]);
      await expect(rejection).to.emit(hub, "BatchRejected").withArgs(batchId, reason, surmaAdmin.address);
      await expect(as(hub, factory).execute(batchId, batch.payouts([0])))
        .to.be.revertedWithCustomError(hub, "InvalidStatus")
        .withArgs(batchId, Status.Rejected);
    });

    it("executes nothing before approval", async () => {
      const { hub, factory, batch, batchId } = await fundedBatch();

      await expect(as(hub, factory).execute(batchId, batch.payouts([0])))
        .to.be.revertedWithCustomError(hub, "InvalidStatus")
        .withArgs(batchId, Status.AwaitingApproval);
      await expect(as(hub, factory).execute(99, [])).to.be.revertedWithCustomError(hub, "UnknownBatch").withArgs(99);
    });
  });

  describe("execution", () => {
    it("pays workers in chunks until the batch is complete", async () => {
      const { hub, token, factory, surmaAdmin, workers, batch, batchId } = await approvedBatch();

      const first = as(hub, factory).execute(batchId, batch.payouts([0, 1, 2, 3, 4, 5]));
      await expect(first).to.changeTokenBalances(token, [workers[0], workers[5], hub], [WAGE, WAGE, -WAGE * 6n]);
      await expect(first).to.emit(hub, "PayoutSettled").withArgs(batchId, 3, workers[3].address, WAGE);

      await as(hub, surmaAdmin).execute(batchId, batch.payouts([6, 7, 8, 9]));
      const record = await hub.batch(batchId);
      expect(record.processed).to.equal(10n);
      expect(record.paid).to.equal(batch.total);
      expect(await hub.isProcessed(batchId, 9)).to.equal(true);
      expect(await token.balanceOf(hub.target)).to.equal(0n);
    });

    it("processes each payout once", async () => {
      const { hub, factory, batch, batchId } = await approvedBatch();
      await as(hub, factory).execute(batchId, batch.payouts([2]));

      await expect(as(hub, factory).execute(batchId, batch.payouts([2])))
        .to.be.revertedWithCustomError(hub, "PayoutAlreadyProcessed")
        .withArgs(batchId, 2);
    });

    it("refuses a payout that the Merkle root does not cover", async () => {
      const { hub, factory, karim, batch, batchId } = await approvedBatch();
      const [payout] = batch.payouts([4]);

      await expect(as(hub, factory).execute(batchId, [{ ...payout, amount: WAGE * 2n }]))
        .to.be.revertedWithCustomError(hub, "InvalidPayout")
        .withArgs(batchId, 4);
      await expect(as(hub, factory).execute(batchId, [{ ...payout, account: karim.address }]))
        .to.be.revertedWithCustomError(hub, "InvalidPayout")
        .withArgs(batchId, 4);
      await expect(as(hub, factory).execute(batchId, [{ ...payout, index: 10 }]))
        .to.be.revertedWithCustomError(hub, "InvalidPayout")
        .withArgs(batchId, 10);
    });

    it("lets only the payer or its bank execute", async () => {
      const { hub, sanguAdmin, karim, batch, batchId } = await approvedBatch();

      for (const caller of [sanguAdmin, karim]) {
        await expect(as(hub, caller).execute(batchId, batch.payouts([0])))
          .to.be.revertedWithCustomError(hub, "NotAuthorised")
          .withArgs(caller.address);
      }
    });

    it("stops a batch that was funded with less than its payout list", async () => {
      const network = await loadFixture(deployNetwork);
      const { hub, factory, surmaAdmin, workers, instruct } = network;
      const batch = payroll(workers.map((worker) => worker.address));
      const underfunded = batch.total - WAGE;
      await instruct(
        factory,
        hub,
        underfunded,
        await hub.encodeBatch(ethers.id("PAYROLL-SHORT"), batch.tree.root, batch.count, SALARY),
      );
      await as(hub, surmaAdmin).approve(0);

      await as(hub, factory).execute(0, batch.payouts([0, 1, 2, 3, 4, 5, 6, 7, 8]));
      await expect(as(hub, factory).execute(0, batch.payouts([9])))
        .to.be.revertedWithCustomError(hub, "BatchOverdrawn")
        .withArgs(0);
    });
  });

  describe("failed payouts and closing", () => {
    it("records an undeliverable payout as failed and returns it to the payer on close", async () => {
      const { hub, token, registry, sanguAdmin, factory, workers, batch, batchId } = await approvedBatch();
      await as(registry, sanguAdmin).freezeAccount(workers[3].address, ethers.id("sim-swap-report"));

      const execution = as(hub, factory).execute(batchId, batch.payouts([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
      await expect(execution).to.emit(hub, "PayoutFailed").withArgs(batchId, 3, workers[3].address, WAGE);
      await expect(execution).to.changeTokenBalances(token, [workers[2], workers[3], workers[4]], [WAGE, 0n, WAGE]);

      const record = await hub.batch(batchId);
      expect(record.paid).to.equal(batch.total - WAGE);
      expect(record.failed).to.equal(WAGE);

      const closing = as(hub, factory).close(batchId);
      await expect(closing).to.changeTokenBalances(token, [hub, factory], [-WAGE, WAGE]);
      await expect(closing)
        .to.emit(hub, "BatchClosed")
        .withArgs(batchId, batch.total - WAGE, WAGE);
      expect((await hub.batch(batchId)).status).to.equal(Status.Closed);
    });

    it("stays open until every payout is processed or the execution window ends", async () => {
      const { hub, token, factory, karim, batch, batchId } = await approvedBatch();
      await as(hub, factory).execute(batchId, batch.payouts([0, 1, 2, 3]));

      await expect(as(hub, factory).close(batchId)).to.be.revertedWithCustomError(hub, "BatchStillOpen");
      await expect(as(hub, karim).close(batchId))
        .to.be.revertedWithCustomError(hub, "NotAuthorised")
        .withArgs(karim.address);

      await time.increase(30 * DAY);
      await expect(as(hub, factory).close(batchId)).to.changeTokenBalance(token, factory, WAGE * 6n);
      await expect(as(hub, factory).execute(batchId, batch.payouts([4])))
        .to.be.revertedWithCustomError(hub, "InvalidStatus")
        .withArgs(batchId, Status.Closed);
    });
  });
});
