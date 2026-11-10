import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { AccountStatus, LIMITS, as, code, deployNetwork, nextDhakaMidnight, role, taka } from "./support/network";

describe("TokenisedTaka", () => {
  it("is denominated in poisha", async () => {
    const { token, registry } = await loadFixture(deployNetwork);

    expect(await token.name()).to.equal("Tokenised Taka");
    expect(await token.symbol()).to.equal("tBDT");
    expect(await token.decimals()).to.equal(2n);
    expect(await token.registry()).to.equal(registry.target);
  });

  it("advertises ERC-1363 and access control through ERC-165", async () => {
    const { token } = await loadFixture(deployNetwork);

    expect(await token.supportsInterface("0xb0202a11")).to.equal(true);
    expect(await token.supportsInterface("0x7965db0b")).to.equal(true);
    expect(await token.supportsInterface("0xffffffff")).to.equal(false);
  });

  describe("supply", () => {
    it("lets only the reserve controller mint and burn", async () => {
      const { token, governance, karim } = await loadFixture(deployNetwork);

      await expect(token.mint(karim.address, taka(1)))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(governance.address, role("MINTER_ROLE"));
      await expect(as(token, karim).burn(taka(1)))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(karim.address, role("MINTER_ROLE"));
    });
  });

  describe("eligibility", () => {
    it("moves value between active accounts of different institutions", async () => {
      const { token, karim, rahima } = await loadFixture(deployNetwork);

      await expect(as(token, karim).transfer(rahima.address, taka(1_500))).to.changeTokenBalances(
        token,
        [karim, rahima],
        [-taka(1_500), taka(1_500)],
      );
    });

    it("refuses a wallet that no institution sponsors", async () => {
      const { token, registry, karim, outsider } = await loadFixture(deployNetwork);

      await expect(as(token, karim).transfer(outsider.address, taka(10)))
        .to.be.revertedWithCustomError(registry, "AccountNotActive")
        .withArgs(outsider.address, AccountStatus.None);
    });

    it("blocks a frozen account in both directions", async () => {
      const { token, registry, supervisor, karim, nusrat } = await loadFixture(deployNetwork);
      await as(registry, supervisor).freezeAccount(nusrat.address, ethers.id("case"));

      await expect(as(token, nusrat).transfer(karim.address, taka(10)))
        .to.be.revertedWithCustomError(registry, "AccountNotActive")
        .withArgs(nusrat.address, AccountStatus.Frozen);
      await expect(as(token, karim).transfer(nusrat.address, taka(10)))
        .to.be.revertedWithCustomError(registry, "AccountNotActive")
        .withArgs(nusrat.address, AccountStatus.Frozen);
    });

    it("blocks the customers of a suspended institution", async () => {
      const { token, registry, supervisor, karim, rahima } = await loadFixture(deployNetwork);
      await as(registry, supervisor).setInstitutionActive(code("SANGU"), false);

      await expect(as(token, karim).transfer(rahima.address, taka(10)))
        .to.be.revertedWithCustomError(registry, "InstitutionInactive")
        .withArgs(code("SANGU"));
    });
  });

  describe("limits", () => {
    it("caps a single transaction at the sender's tier limit", async () => {
      const { token, sanguSettlement, rahima, karim } = await loadFixture(deployNetwork);
      await as(token, sanguSettlement).transfer(rahima.address, taka(60_000));
      const overLimit = LIMITS.basic.perTransaction + 1n;

      await expect(as(token, rahima).transfer(karim.address, overLimit))
        .to.be.revertedWithCustomError(token, "TransactionLimitExceeded")
        .withArgs(rahima.address, overLimit, LIMITS.basic.perTransaction);
      await expect(as(token, rahima).transfer(karim.address, LIMITS.basic.perTransaction)).to.not.be.reverted;
    });

    it("adds up the day's outflow and starts again at midnight in Dhaka", async () => {
      const { token, sanguSettlement, rahima, karim } = await loadFixture(deployNetwork);
      await as(token, sanguSettlement).transfer(rahima.address, taka(80_000));
      await time.increaseTo(await nextDhakaMidnight());

      await as(token, rahima).transfer(karim.address, taka(25_000));
      await as(token, rahima).transfer(karim.address, taka(25_000));
      expect(await token.spentToday(rahima.address)).to.equal(taka(50_000));

      await expect(as(token, rahima).transfer(karim.address, taka(1)))
        .to.be.revertedWithCustomError(token, "DailyLimitExceeded")
        .withArgs(rahima.address, taka(50_000) + taka(1), LIMITS.basic.dailyOutflow);

      const today = await token.businessDay();
      await time.increaseTo(await nextDhakaMidnight());
      expect(await token.businessDay()).to.equal(today + 1n);
      expect(await token.spentToday(rahima.address)).to.equal(0n);
      await expect(as(token, rahima).transfer(karim.address, taka(1_000))).to.not.be.reverted;
    });

    it("keeps a balance under the cap of the receiver's tier", async () => {
      const { token, surmaSettlement, rahima } = await loadFixture(deployNetwork);
      const balance = await token.balanceOf(rahima.address);
      const room = LIMITS.basic.maxBalance - balance;

      await expect(as(token, surmaSettlement).transfer(rahima.address, room + 1n))
        .to.be.revertedWithCustomError(token, "BalanceCapExceeded")
        .withArgs(rahima.address, LIMITS.basic.maxBalance + 1n, LIMITS.basic.maxBalance);
      await expect(as(token, surmaSettlement).transfer(rahima.address, room)).to.not.be.reverted;
    });

    it("applies no limit to institutions and merchants", async () => {
      const { token, surmaSettlement, sanguSettlement, shop } = await loadFixture(deployNetwork);

      await expect(as(token, surmaSettlement).transfer(sanguSettlement.address, taka(3_000_000))).to.not.be.reverted;
      await expect(as(token, sanguSettlement).transfer(shop.address, taka(3_000_000))).to.not.be.reverted;
    });
  });

  describe("controls", () => {
    it("halts every movement while paused", async () => {
      const { token, supervisor, karim, nusrat } = await loadFixture(deployNetwork);

      await expect(as(token, karim).pause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await as(token, supervisor).pause();
      await expect(as(token, karim).transfer(nusrat.address, taka(10))).to.be.revertedWithCustomError(
        token,
        "EnforcedPause",
      );

      await as(token, supervisor).unpause();
      await expect(as(token, karim).transfer(nusrat.address, taka(10))).to.not.be.reverted;
    });

    it("executes a legal order against a frozen account", async () => {
      const { token, registry, supervisor, surmaSettlement, nusrat, outsider } = await loadFixture(deployNetwork);
      const orderRef = ethers.id("order-2026-118");
      await as(registry, supervisor).freezeAccount(nusrat.address, orderRef);

      await expect(as(token, supervisor).forceTransfer(nusrat.address, surmaSettlement.address, taka(50_000), orderRef))
        .to.emit(token, "ForcedTransfer")
        .withArgs(nusrat.address, surmaSettlement.address, taka(50_000), orderRef, supervisor.address);
      expect(await token.balanceOf(nusrat.address)).to.equal(0n);

      await expect(
        as(token, supervisor).forceTransfer(surmaSettlement.address, outsider.address, taka(1), orderRef),
      ).to.be.revertedWithCustomError(registry, "AccountNotActive");
      await expect(
        as(token, surmaSettlement).forceTransfer(nusrat.address, surmaSettlement.address, taka(1), orderRef),
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("transferAndCall", () => {
    it("refuses a receiver that cannot take an instruction", async () => {
      const { token, karim, nusrat } = await loadFixture(deployNetwork);

      await expect(
        as(token, karim)["transferAndCall(address,uint256,bytes)"](nusrat.address, taka(10), "0x"),
      ).to.be.revertedWithCustomError(token, "ERC1363InvalidReceiver");
    });
  });
});
