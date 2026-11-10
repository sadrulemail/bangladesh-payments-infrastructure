import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { expect } from "chai";
import { ethers } from "hardhat";

import { AED_RATE, RATE_SCALE, as, ascii, code, deployNetwork, taka } from "./support/network";

/**
 * Conservation of value across the whole network: after a busy day that touches every module,
 * supply is fully held by known accounts, it stays within the reserve, and each module holds
 * exactly what it owes.
 */
describe("Conservation of value", () => {
  async function busyDay() {
    const network = await loadFixture(deployNetwork);
    const { controller, paymentSwitch, gateway, hub, instruct } = network;
    const { karim, nusrat, rahima, shop, factory, workers } = network;
    const { surmaAdmin, surmaSettlement, dhowSettlement, checker, compliance } = network;
    const fils = (amount: number) => ethers.parseUnits(String(amount), 2);
    const remit = async (beneficiary: string, sourceAmount: bigint, reference: string) =>
      instruct(
        dhowSettlement,
        gateway,
        (sourceAmount * AED_RATE) / RATE_SCALE,
        await gateway.encodeRemittance(
          code("AE-BD"),
          beneficiary,
          sourceAmount,
          AED_RATE,
          ascii("FAMI"),
          ethers.id(reference),
        ),
      );

    // Retail payments, a refund and a person-to-person transfer.
    const merchantPayment = await paymentSwitch.encodeMerchantPayment(code("NAKSHI-01"), ethers.ZeroHash);
    await instruct(karim, paymentSwitch, taka("1830.75"), merchantPayment);
    await instruct(rahima, paymentSwitch, taka("412.40"), merchantPayment);
    await instruct(shop, paymentSwitch, taka(200), await paymentSwitch.encodeRefund(0));
    await instruct(
      nusrat,
      paymentSwitch,
      taka(7_500),
      await paymentSwitch.encodePersonTransfer(rahima.address, ethers.id("E2E-1"), ascii("FAMI")),
    );

    // Remittances: one paid straight through, one released, one rejected, one still under review.
    await remit(rahima.address, fils(900), "R-1");
    await remit(karim.address, fils(5_000), "R-2");
    await remit(nusrat.address, fils(5_500), "R-3");
    await remit(karim.address, fils(6_200), "R-4");
    await as(gateway, compliance).release(1);
    await as(gateway, compliance).reject(2, ethers.id("documents-missing"));

    // Payroll: approved, partly executed.
    const leaves = workers.map((worker, index): [number, string, bigint] => [index, worker.address, taka(11_000)]);
    const tree = StandardMerkleTree.of(leaves, ["uint32", "address", "uint128"]);
    const total = taka(11_000) * BigInt(leaves.length);
    await instruct(
      factory,
      hub,
      total,
      await hub.encodeBatch(ethers.id("PAYROLL"), tree.root, leaves.length, ascii("SALA")),
    );
    await as(hub, surmaAdmin).approve(0);
    const payouts = [0, 1, 2, 3].map((index) => ({
      index,
      account: leaves[index][1],
      amount: leaves[index][2],
      proof: tree.getProof(index),
    }));
    await as(hub, factory).execute(0, payouts);

    // Redemptions: one settled, one pending.
    await instruct(surmaSettlement, controller, taka(250_000), await controller.encodeRedemption(ethers.id("P-1")));
    await instruct(surmaSettlement, controller, taka(90_000), await controller.encodeRedemption(ethers.id("P-2")));
    await as(controller, checker).settleRedemption(0);

    return network;
  }

  it("keeps the whole supply in accounts the registry knows", async () => {
    const network = await busyDay();
    const { token, controller, paymentSwitch, gateway, hub, workers } = network;
    const holders = [
      network.feeCollector,
      network.teestaSettlement,
      network.surmaSettlement,
      network.sanguSettlement,
      network.dhowSettlement,
      network.treasurySettlement,
      network.rahima,
      network.karim,
      network.nusrat,
      network.shop,
      network.factory,
      ...workers,
    ].map((signer) => signer.address);
    const modules = [controller, paymentSwitch, gateway, hub].map((module) => module.target as string);

    let held = 0n;
    for (const holder of [...holders, ...modules]) held += await token.balanceOf(holder);

    expect(held).to.equal(await token.totalSupply());
  });

  it("keeps supply within the reserve statement", async () => {
    const { token, controller } = await busyDay();

    expect(await token.totalSupply()).to.be.lessThanOrEqual((await controller.currentStatement()).balance);
  });

  it("leaves each module holding exactly what it owes", async () => {
    const { token, controller, paymentSwitch, gateway, hub } = await busyDay();

    const underReview = (await gateway.remittance(3)).amount;
    const batch = await hub.batch(0);
    const pendingRedemption = (await controller.redemption(1)).amount;

    expect(await token.balanceOf(paymentSwitch.target)).to.equal(0n);
    expect(await token.balanceOf(gateway.target)).to.equal((await gateway.incentivePool()) + underReview);
    expect(await token.balanceOf(hub.target)).to.equal(batch.total - batch.paid);
    expect(await token.balanceOf(controller.target)).to.equal(pendingRedemption);
  });

  it("returns every module to zero once all obligations are settled", async () => {
    const network = await busyDay();
    const { token, controller, gateway, hub, compliance, checker, factory, treasurySettlement } = network;

    await as(gateway, compliance).release(3);
    await time.increase(30 * 24 * 60 * 60);
    await as(hub, factory).close(0);
    await as(controller, checker).settleRedemption(1);

    expect(await token.balanceOf(hub.target)).to.equal(0n);
    expect(await token.balanceOf(controller.target)).to.equal(0n);
    expect(await token.balanceOf(gateway.target)).to.equal(await gateway.incentivePool());
    expect(await token.balanceOf(treasurySettlement.address)).to.equal(taka(900_000));
  });
});
