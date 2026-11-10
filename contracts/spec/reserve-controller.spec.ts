import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { DAY, as, chainTime, code, deployNetwork, role, taka } from "./support/network";

enum RequestStatus {
  None,
  Pending,
  Completed,
  Rejected,
}

describe("ReserveController", () => {
  const fundingRef = ethers.id("rtgs:TEESTA:20261110:000187");
  const payoutRef = ethers.id("beftn:SURMA:20261110:004410");

  describe("reserve statements", () => {
    it("records statements in chronological order", async () => {
      const { controller, auditor } = await loadFixture(deployNetwork);
      const asOf = await chainTime();
      const documentHash = ethers.id("statement-2026-11-10.pdf");

      await expect(as(controller, auditor).publishReserveStatement(asOf, taka(2_000_000_000), documentHash))
        .to.emit(controller, "ReserveStatementPublished")
        .withArgs(1n, asOf, taka(2_000_000_000), documentHash, auditor.address);
      expect((await controller.currentStatement()).balance).to.equal(taka(2_000_000_000));
      expect(await controller.reserveStatementCount()).to.equal(2n);

      await expect(as(controller, auditor).publishReserveStatement(asOf, taka(1), documentHash))
        .to.be.revertedWithCustomError(controller, "InvalidStatementDate")
        .withArgs(asOf);
      await expect(
        as(controller, auditor).publishReserveStatement(asOf + 30 * DAY, taka(1), documentHash),
      ).to.be.revertedWithCustomError(controller, "InvalidStatementDate");
    });

    it("accepts statements from the auditor only", async () => {
      const { controller, maker } = await loadFixture(deployNetwork);

      await expect(as(controller, maker).publishReserveStatement(await chainTime(), taka(1), ethers.ZeroHash))
        .to.be.revertedWithCustomError(controller, "AccessControlUnauthorizedAccount")
        .withArgs(maker.address, role("AUDITOR_ROLE"));
    });
  });

  describe("issuance", () => {
    it("mints to the settlement account once a second officer approves", async () => {
      const { controller, token, maker, checker, surmaSettlement } = await loadFixture(deployNetwork);
      const id = await controller.issuanceCount();

      await expect(as(controller, maker).requestIssuance(code("SURMA"), taka(750_000), fundingRef))
        .to.emit(controller, "IssuanceRequested")
        .withArgs(id, code("SURMA"), taka(750_000), fundingRef, maker.address);
      expect((await controller.issuance(id)).status).to.equal(RequestStatus.Pending);

      const balance = await token.balanceOf(surmaSettlement.address);
      await expect(as(controller, checker).approveIssuance(id))
        .to.emit(controller, "IssuanceApproved")
        .withArgs(id, code("SURMA"), surmaSettlement.address, taka(750_000), checker.address);
      expect(await token.balanceOf(surmaSettlement.address)).to.equal(balance + taka(750_000));

      const request = await controller.issuance(id);
      expect(request.status).to.equal(RequestStatus.Completed);
      expect(request.checker).to.equal(checker.address);
    });

    it("never lets the maker approve its own request", async () => {
      const { controller, maker } = await loadFixture(deployNetwork);
      await controller.grantRole(role("CHECKER_ROLE"), maker.address);
      const id = await controller.issuanceCount();
      await as(controller, maker).requestIssuance(code("SURMA"), taka(1_000), fundingRef);

      await expect(as(controller, maker).approveIssuance(id))
        .to.be.revertedWithCustomError(controller, "MakerCannotApprove")
        .withArgs(maker.address);
    });

    it("funds one issuance per bank transfer", async () => {
      const { controller, maker, checker } = await loadFixture(deployNetwork);
      const id = await controller.issuanceCount();
      await as(controller, maker).requestIssuance(code("SURMA"), taka(1_000), fundingRef);

      await expect(as(controller, maker).requestIssuance(code("SANGU"), taka(1_000), fundingRef))
        .to.be.revertedWithCustomError(controller, "FundingRefUsed")
        .withArgs(fundingRef);

      await as(controller, checker).rejectIssuance(id, ethers.id("amount-mismatch"));
      await expect(
        as(controller, maker).requestIssuance(code("SURMA"), taka(1_000), fundingRef),
      ).to.be.revertedWithCustomError(controller, "FundingRefUsed");
    });

    it("keeps supply within the reserve statement", async () => {
      const { controller, token, maker, checker, publishReserve } = await loadFixture(deployNetwork);
      const supply = await token.totalSupply();
      await time.increase(60);
      await publishReserve(supply + taka(500));
      const id = await controller.issuanceCount();
      await as(controller, maker).requestIssuance(code("SURMA"), taka(501), fundingRef);

      await expect(as(controller, checker).approveIssuance(id))
        .to.be.revertedWithCustomError(controller, "ReserveExceeded")
        .withArgs(supply + taka(501), supply + taka(500));

      await as(controller, maker).requestIssuance(code("SURMA"), taka(500), ethers.id("second-transfer"));
      await expect(as(controller, checker).approveIssuance(id + 1n)).to.not.be.reverted;
      expect(await token.totalSupply()).to.equal(supply + taka(500));
    });

    it("stops issuing when the reserve statement is stale", async () => {
      const { controller, maker, checker } = await loadFixture(deployNetwork);
      const id = await controller.issuanceCount();
      await as(controller, maker).requestIssuance(code("SURMA"), taka(1_000), fundingRef);
      await time.increase(2 * DAY + 1);

      await expect(as(controller, checker).approveIssuance(id)).to.be.revertedWithCustomError(
        controller,
        "ReserveStatementStale",
      );
    });

    it("needs a reserve statement before the first issuance", async () => {
      const { registry, token, governance, maker, checker } = await loadFixture(deployNetwork);
      const bare = await ethers.deployContract("ReserveController", [
        governance.address,
        token.target,
        registry.target,
        2 * DAY,
      ]);
      await bare.grantRole(role("MAKER_ROLE"), maker.address);
      await bare.grantRole(role("CHECKER_ROLE"), checker.address);
      await as(bare, maker).requestIssuance(code("SURMA"), taka(1_000), fundingRef);

      await expect(as(bare, checker).approveIssuance(0)).to.be.revertedWithCustomError(bare, "ReserveStatementMissing");
    });

    it("refuses unknown or suspended institutions, empty amounts and decided requests", async () => {
      const { controller, registry, supervisor, maker, checker } = await loadFixture(deployNetwork);

      await expect(as(controller, maker).requestIssuance(code("NOBODY"), taka(1), fundingRef))
        .to.be.revertedWithCustomError(controller, "InstitutionNotActive")
        .withArgs(code("NOBODY"));
      await expect(as(controller, maker).requestIssuance(code("SURMA"), 0, fundingRef)).to.be.revertedWithCustomError(
        controller,
        "InvalidAmount",
      );

      const id = await controller.issuanceCount();
      await as(controller, maker).requestIssuance(code("SURMA"), taka(1_000), fundingRef);
      await as(registry, supervisor).setInstitutionActive(code("SURMA"), false);
      await expect(as(controller, checker).approveIssuance(id)).to.be.revertedWithCustomError(
        controller,
        "InstitutionNotActive",
      );

      await expect(as(controller, checker).rejectIssuance(id, ethers.id("suspended")))
        .to.emit(controller, "IssuanceRejected")
        .withArgs(id, ethers.id("suspended"), checker.address);
      await expect(as(controller, checker).approveIssuance(id))
        .to.be.revertedWithCustomError(controller, "RequestNotPending")
        .withArgs(id, RequestStatus.Rejected);
      await expect(as(controller, checker).approveIssuance(999)).to.be.revertedWithCustomError(
        controller,
        "UnknownRequest",
      );
    });
  });

  describe("redemption", () => {
    it("holds the tBDT until the payout is confirmed, then burns it", async () => {
      const { controller, token, checker, surmaSettlement, instruct } = await loadFixture(deployNetwork);
      const supply = await token.totalSupply();
      const id = await controller.redemptionCount();
      const instruction = await controller.encodeRedemption(payoutRef);

      await expect(instruct(surmaSettlement, controller, taka(400_000), instruction))
        .to.emit(controller, "RedemptionRequested")
        .withArgs(id, code("SURMA"), surmaSettlement.address, taka(400_000), payoutRef);
      expect(await token.balanceOf(controller.target)).to.equal(taka(400_000));
      expect(await token.totalSupply()).to.equal(supply);

      await expect(as(controller, checker).settleRedemption(id))
        .to.emit(controller, "RedemptionSettled")
        .withArgs(id, taka(400_000), checker.address);
      expect(await token.totalSupply()).to.equal(supply - taka(400_000));
      expect(await token.balanceOf(controller.target)).to.equal(0n);
      expect((await controller.redemption(id)).status).to.equal(RequestStatus.Completed);
    });

    it("returns the tBDT when a redemption is rejected", async () => {
      const { controller, token, checker, surmaSettlement, instruct } = await loadFixture(deployNetwork);
      const id = await controller.redemptionCount();
      await instruct(surmaSettlement, controller, taka(400_000), await controller.encodeRedemption(payoutRef));

      await expect(as(controller, checker).rejectRedemption(id, ethers.id("account-closed"))).to.changeTokenBalances(
        token,
        [controller, surmaSettlement],
        [-taka(400_000), taka(400_000)],
      );
      await expect(as(controller, checker).settleRedemption(id))
        .to.be.revertedWithCustomError(controller, "RequestNotPending")
        .withArgs(id, RequestStatus.Rejected);
    });

    it("redeems for settlement accounts only", async () => {
      const { controller, karim, instruct } = await loadFixture(deployNetwork);

      await expect(instruct(karim, controller, taka(100), await controller.encodeRedemption(payoutRef)))
        .to.be.revertedWithCustomError(controller, "NotSettlementAccount")
        .withArgs(karim.address);
    });

    it("takes instructions from the token only", async () => {
      const { controller, karim } = await loadFixture(deployNetwork);

      await expect(as(controller, karim).onTransferReceived(karim.address, karim.address, taka(100), "0x"))
        .to.be.revertedWithCustomError(controller, "UnauthorisedToken")
        .withArgs(karim.address);
    });
  });
});
