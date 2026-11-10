import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import type { Signer } from "ethers";
import { ethers } from "hardhat";

import {
  AED_RATE,
  DAY,
  GATEWAY_POLICY,
  Kind,
  Network,
  RATE_SCALE,
  as,
  ascii,
  code,
  deployNetwork,
  rate,
  role,
  taka,
} from "./support/network";

enum Status {
  None,
  UnderReview,
  Paid,
  Rejected,
  Reclaimed,
}

const AE_BD = code("AE-BD");
const FAMILY = ascii("FAMI");

/** Dirham amount in fils. */
const aed = (amount: number | string) => ethers.parseUnits(String(amount), 2);

const convert = (sourceAmount: bigint, quotedRate: bigint) => (sourceAmount * quotedRate) / RATE_SCALE;

describe("RemittanceGateway", () => {
  /** Originates a remittance from the Dubai exchange house at the reference rate unless told otherwise. */
  async function remit(
    network: Network,
    beneficiary: Signer,
    sourceAmount: bigint,
    options: { quotedRate?: bigint; amount?: bigint; senderRef?: string; corridor?: string; from?: Signer } = {},
  ) {
    const { gateway, dhowSettlement, instruct } = network;
    const quotedRate = options.quotedRate ?? AED_RATE;
    const instruction = await gateway.encodeRemittance(
      options.corridor ?? AE_BD,
      await beneficiary.getAddress(),
      sourceAmount,
      quotedRate,
      FAMILY,
      options.senderRef ?? ethers.id(`DHOW-${sourceAmount}-${quotedRate}`),
    );
    const amount = options.amount ?? convert(sourceAmount, quotedRate);
    return instruct(options.from ?? dhowSettlement, gateway, amount, instruction);
  }

  describe("straight-through payout", () => {
    it("pays the principal and the 2.5% incentive to the beneficiary at once", async () => {
      const network = await loadFixture(deployNetwork);
      const { gateway, token, dhowSettlement, rahima } = network;
      const id = await gateway.remittanceCount();
      const pool = await gateway.incentivePool();
      const senderRef = ethers.id("DHOW-20261110-0007731");

      // AED 1,000.00 at 33.25 is BDT 33,250.00; the incentive is BDT 831.25.
      const remittance = remit(network, rahima, aed(1_000), { senderRef });
      await expect(remittance).to.changeTokenBalances(
        token,
        [dhowSettlement, rahima, gateway],
        [-taka(33_250), taka("34081.25"), -taka("831.25")],
      );
      await expect(remittance)
        .to.emit(gateway, "RemittanceReceived")
        .withArgs(id, AE_BD, code("DHOW"), rahima.address, taka(33_250), aed(1_000), AED_RATE, FAMILY, senderRef, false)
        .and.to.emit(gateway, "RemittancePaid")
        .withArgs(id, rahima.address, taka(33_250), taka("831.25"), true);

      const record = await gateway.remittance(id);
      expect(record.status).to.equal(Status.Paid);
      expect(record.incentivePaid).to.equal(true);
      expect(await gateway.incentivePool()).to.equal(pool - taka("831.25"));
    });

    it("quotes the payout at the reference rate", async () => {
      const { gateway } = await loadFixture(deployNetwork);

      expect(await gateway.quote(AE_BD, aed(1_000))).to.deep.equal([taka(33_250), taka("831.25")]);
    });
  });

  describe("compliance review", () => {
    async function heldRemittance() {
      const network = await loadFixture(deployNetwork);
      const id: bigint = await network.gateway.remittanceCount();
      // AED 6,000.00 is BDT 199,500.00, above the BDT 150,000 screening threshold.
      await remit(network, network.karim, aed(6_000));
      return { ...network, id };
    }

    it("holds a remittance above the screening threshold", async () => {
      const { gateway, token, karim, id } = await heldRemittance();

      expect((await gateway.remittance(id)).status).to.equal(Status.UnderReview);
      expect(await token.balanceOf(karim.address)).to.equal(taka(100_000));
    });

    it("pays the beneficiary when compliance releases it", async () => {
      const { gateway, token, compliance, karim, outsider, id } = await heldRemittance();

      await expect(as(gateway, outsider).release(id))
        .to.be.revertedWithCustomError(gateway, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, role("COMPLIANCE_ROLE"));

      await expect(as(gateway, compliance).release(id)).to.changeTokenBalance(
        token,
        karim,
        taka(199_500) + taka("4987.50"),
      );
      await expect(as(gateway, compliance).release(id))
        .to.be.revertedWithCustomError(gateway, "InvalidStatus")
        .withArgs(id, Status.Paid);
    });

    it("returns the principal to the exchange house when compliance rejects it", async () => {
      const { gateway, token, compliance, dhowSettlement, karim, id } = await heldRemittance();
      const reason = ethers.id("sanctions-screening-hit");

      const rejection = as(gateway, compliance).reject(id, reason);
      await expect(rejection).to.changeTokenBalances(token, [dhowSettlement, karim], [taka(199_500), 0n]);
      await expect(rejection).to.emit(gateway, "RemittanceRejected").withArgs(id, reason, compliance.address);
      expect((await gateway.remittance(id)).status).to.equal(Status.Rejected);
    });

    it("lets the exchange house reclaim once the review window has passed", async () => {
      const { gateway, token, dhowSettlement, karim, id } = await heldRemittance();

      await expect(as(gateway, dhowSettlement).reclaim(id)).to.be.revertedWithCustomError(gateway, "ReviewWindowOpen");
      await time.increase(GATEWAY_POLICY.reviewWindow);
      await expect(as(gateway, karim).reclaim(id))
        .to.be.revertedWithCustomError(gateway, "NotOriginator")
        .withArgs(karim.address);

      await expect(as(gateway, dhowSettlement).reclaim(id)).to.changeTokenBalance(token, dhowSettlement, taka(199_500));
      expect((await gateway.remittance(id)).status).to.equal(Status.Reclaimed);
    });
  });

  describe("exchange rate", () => {
    it("accepts a quote at the edge of the band and refuses one beyond it", async () => {
      const network = await loadFixture(deployNetwork);
      const { gateway, rahima } = network;
      const band = (AED_RATE * BigInt(GATEWAY_POLICY.rateBandBps)) / 10_000n;

      await expect(remit(network, rahima, aed(100), { quotedRate: AED_RATE - band })).to.not.be.reverted;
      await expect(remit(network, rahima, aed(100), { quotedRate: AED_RATE + band })).to.not.be.reverted;
      await expect(remit(network, rahima, aed(100), { quotedRate: AED_RATE - band - 1n }))
        .to.be.revertedWithCustomError(gateway, "RateOutsideBand")
        .withArgs(AED_RATE - band - 1n, AED_RATE);
      await expect(
        remit(network, rahima, aed(100), { quotedRate: AED_RATE + band + 1n }),
      ).to.be.revertedWithCustomError(gateway, "RateOutsideBand");
    });

    it("requires the tBDT sent to match the source amount at the quoted rate", async () => {
      const network = await loadFixture(deployNetwork);

      await expect(remit(network, network.rahima, aed(1_000), { amount: taka(33_249) }))
        .to.be.revertedWithCustomError(network.gateway, "AmountMismatch")
        .withArgs(taka(33_249), taka(33_250));
    });

    it("refuses to settle against a stale or missing reference rate", async () => {
      const network = await loadFixture(deployNetwork);
      const { gateway, maker, rahima } = network;

      await gateway.configureCorridor(code("SA-BD"), ascii("SAR"), taka(500_000), true);
      await gateway.setOriginator(code("SA-BD"), code("DHOW"), true);
      await expect(remit(network, rahima, aed(100), { corridor: code("SA-BD") }))
        .to.be.revertedWithCustomError(gateway, "ReferenceRateMissing")
        .withArgs(code("SA-BD"));

      await time.increase(GATEWAY_POLICY.rateValidity + 1);
      await expect(remit(network, rahima, aed(100))).to.be.revertedWithCustomError(gateway, "ReferenceRateExpired");

      await expect(as(gateway, maker).publishRate(AE_BD, rate("33.40")))
        .to.emit(gateway, "ReferenceRatePublished")
        .withArgs(AE_BD, rate("33.40"), maker.address);
      await expect(remit(network, rahima, aed(100), { quotedRate: rate("33.40") })).to.not.be.reverted;
    });

    it("takes rates from the rate publisher only", async () => {
      const { gateway, compliance, maker } = await loadFixture(deployNetwork);

      await expect(as(gateway, compliance).publishRate(AE_BD, AED_RATE)).to.be.revertedWithCustomError(
        gateway,
        "AccessControlUnauthorizedAccount",
      );
      await expect(as(gateway, maker).publishRate(AE_BD, 0)).to.be.revertedWithCustomError(gateway, "InvalidAmount");
      await expect(as(gateway, maker).publishRate(code("XX-BD"), AED_RATE))
        .to.be.revertedWithCustomError(gateway, "UnknownCorridor")
        .withArgs(code("XX-BD"));
    });
  });

  describe("origination rules", () => {
    it("accepts remittances from authorised exchange houses only", async () => {
      const network = await loadFixture(deployNetwork);
      const { gateway, surmaSettlement, karim, rahima } = network;

      await expect(remit(network, rahima, aed(100), { from: surmaSettlement }))
        .to.be.revertedWithCustomError(gateway, "OriginatorNotAuthorised")
        .withArgs(surmaSettlement.address);
      await expect(remit(network, rahima, aed(100), { from: karim }))
        .to.be.revertedWithCustomError(gateway, "OriginatorNotAuthorised")
        .withArgs(karim.address);

      await gateway.setOriginator(AE_BD, code("DHOW"), false);
      await expect(remit(network, rahima, aed(100))).to.be.revertedWithCustomError(gateway, "OriginatorNotAuthorised");
      await expect(gateway.setOriginator(AE_BD, code("SURMA"), true))
        .to.be.revertedWithCustomError(gateway, "NotExchangeHouse")
        .withArgs(code("SURMA"));
    });

    it("accepts each originator reference once", async () => {
      const network = await loadFixture(deployNetwork);
      const senderRef = ethers.id("DHOW-20261110-0007740");
      await remit(network, network.rahima, aed(200), { senderRef });

      await expect(remit(network, network.rahima, aed(200), { senderRef }))
        .to.be.revertedWithCustomError(network.gateway, "DuplicateReference")
        .withArgs(senderRef);
    });

    it("enforces the corridor's status and cap and the beneficiary's eligibility", async () => {
      const network = await loadFixture(deployNetwork);
      const { gateway, registry, supervisor, karim, nusrat, outsider } = network;

      await expect(remit(network, outsider, aed(100)))
        .to.be.revertedWithCustomError(gateway, "BeneficiaryNotEligible")
        .withArgs(outsider.address);
      await as(registry, supervisor).freezeAccount(nusrat.address, ethers.id("case"));
      await expect(remit(network, nusrat, aed(100))).to.be.revertedWithCustomError(gateway, "BeneficiaryNotEligible");

      // AED 16,000.00 is BDT 532,000.00, above the BDT 500,000 corridor cap.
      await expect(remit(network, karim, aed(16_000)))
        .to.be.revertedWithCustomError(gateway, "AmountAboveCorridorCap")
        .withArgs(taka(532_000), taka(500_000));

      await gateway.configureCorridor(AE_BD, ascii("AED"), taka(500_000), false);
      await expect(remit(network, karim, aed(100)))
        .to.be.revertedWithCustomError(gateway, "CorridorInactive")
        .withArgs(AE_BD);
    });

    it("keeps one entry per corridor in the corridor list", async () => {
      const { gateway } = await loadFixture(deployNetwork);

      await gateway.configureCorridor(AE_BD, ascii("AED"), taka(750_000), true);
      await gateway.configureCorridor(code("MY-BD"), ascii("MYR"), taka(300_000), true);

      expect(await gateway.corridorIds()).to.deep.equal([AE_BD, code("MY-BD")]);
      expect((await gateway.corridor(AE_BD)).maxAmount).to.equal(taka(750_000));
      await expect(gateway.configureCorridor(ethers.ZeroHash, ascii("AED"), 1, true)).to.be.revertedWithCustomError(
        gateway,
        "InvalidCorridor",
      );
    });
  });

  describe("incentive pool", () => {
    async function emptyPool() {
      const network = await loadFixture(deployNetwork);
      const { registry, token, governance, dhowSettlement, maker } = network;
      const gateway = await ethers.deployContract("RemittanceGateway", [
        governance.address,
        token.target,
        registry.target,
        GATEWAY_POLICY,
      ]);
      await registry.registerSystemAccount(code("NETWORK"), gateway.target);
      await gateway.grantRole(role("CORRIDOR_ROLE"), governance.address);
      await gateway.grantRole(role("RATE_PUBLISHER_ROLE"), maker.address);
      await gateway.configureCorridor(AE_BD, ascii("AED"), taka(500_000), true);
      await gateway.setOriginator(AE_BD, code("DHOW"), true);
      await as(gateway, maker).publishRate(AE_BD, AED_RATE);
      expect((await registry.institution(code("DHOW"))).kind).to.equal(Kind.ExchangeHouse);
      expect(await token.balanceOf(dhowSettlement.address)).to.be.greaterThan(0n);
      return { ...network, gateway };
    }

    it("never holds back the principal when the pool is short, and pays the incentive later", async () => {
      const network = await emptyPool();
      const { gateway, token, treasurySettlement, rahima, instruct } = network;
      const id = await gateway.remittanceCount();

      await expect(remit(network, rahima, aed(1_000))).to.changeTokenBalance(token, rahima, taka(33_250));
      expect((await gateway.remittance(id)).incentivePaid).to.equal(false);
      await expect(gateway.settleIncentive(id))
        .to.be.revertedWithCustomError(gateway, "IncentivePoolInsufficient")
        .withArgs(taka("831.25"), 0n);

      const funding = instruct(treasurySettlement, gateway, taka(10_000), await gateway.encodeIncentiveFunding());
      await expect(funding)
        .to.emit(gateway, "IncentivePoolFunded")
        .withArgs(treasurySettlement.address, taka(10_000), taka(10_000));

      const settlement = gateway.settleIncentive(id);
      await expect(settlement).to.changeTokenBalance(token, rahima, taka("831.25"));
      await expect(settlement).to.emit(gateway, "IncentiveSettled").withArgs(id, rahima.address, taka("831.25"));
      await expect(gateway.settleIncentive(id)).to.be.revertedWithCustomError(gateway, "IncentiveNotDue").withArgs(id);
    });

    it("is funded from institution accounts only", async () => {
      const { gateway, karim, instruct } = await loadFixture(deployNetwork);

      await expect(instruct(karim, gateway, taka(100), await gateway.encodeIncentiveFunding()))
        .to.be.revertedWithCustomError(gateway, "NotInstitutionAccount")
        .withArgs(karim.address);
    });
  });

  describe("policy", () => {
    it("is set by the corridor role within sane bounds", async () => {
      const { gateway, outsider } = await loadFixture(deployNetwork);
      const policy = { ...GATEWAY_POLICY, incentiveBps: 300, reviewWindow: 2 * DAY };

      await expect(as(gateway, outsider).setPolicy(policy)).to.be.revertedWithCustomError(
        gateway,
        "AccessControlUnauthorizedAccount",
      );
      await expect(gateway.setPolicy({ ...policy, incentiveBps: 1_001 })).to.be.revertedWithCustomError(
        gateway,
        "InvalidPolicy",
      );
      await expect(gateway.setPolicy({ ...policy, rateValidity: 0 })).to.be.revertedWithCustomError(
        gateway,
        "InvalidPolicy",
      );

      await expect(gateway.setPolicy(policy))
        .to.emit(gateway, "PolicyChanged")
        .withArgs(300, policy.rateBandBps, policy.rateValidity, 2 * DAY, policy.screeningThreshold);
      expect((await gateway.policy()).incentiveBps).to.equal(300n);
    });
  });
});
