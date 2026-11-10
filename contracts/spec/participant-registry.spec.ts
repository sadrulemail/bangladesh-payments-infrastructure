import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { AccountStatus, Kind, LIMITS, Tier, as, ascii, code, deployNetwork, role, taka } from "./support/network";

describe("ParticipantRegistry", () => {
  const identityRef = ethers.id("kyc:new-customer");

  describe("institutions", () => {
    it("admits an institution and opens its settlement account", async () => {
      const { registry, outsider, workers } = await loadFixture(deployNetwork);
      const [admin, settlement] = [outsider, workers[9]];
      const fresh = ethers.Wallet.createRandom().address;

      await expect(
        registry.registerInstitution(
          code("HALDA"),
          Kind.CommercialBank,
          "Halda Bank",
          ascii("BD"),
          admin.address,
          fresh,
        ),
      )
        .to.emit(registry, "InstitutionRegistered")
        .withArgs(code("HALDA"), Kind.CommercialBank, "Halda Bank", ascii("BD"), admin.address, fresh)
        .and.to.emit(registry, "AccountOpened")
        .withArgs(fresh, code("HALDA"), Tier.Institution, ethers.ZeroHash);

      const institution = await registry.institution(code("HALDA"));
      expect(institution.active).to.equal(true);
      expect(institution.settlementAccount).to.equal(fresh);
      expect(await registry.institutionOfAdmin(admin.address)).to.equal(code("HALDA"));
      expect(await registry.institutionIds()).to.include(code("HALDA"));
      expect(settlement.address).to.not.equal(fresh);
    });

    it("rejects a duplicate id, a reused administrator and malformed input", async () => {
      const { registry, surmaAdmin, outsider } = await loadFixture(deployNetwork);
      const wallet = ethers.Wallet.createRandom().address;
      const register = (id: string, kind: Kind, admin: string, settlement: string) =>
        registry.registerInstitution(code(id), kind, "Name", ascii("BD"), admin, settlement);

      await expect(register("SURMA", Kind.CommercialBank, outsider.address, wallet))
        .to.be.revertedWithCustomError(registry, "InstitutionExists")
        .withArgs(code("SURMA"));
      await expect(register("HALDA", Kind.CommercialBank, surmaAdmin.address, wallet))
        .to.be.revertedWithCustomError(registry, "AdminAlreadyAssigned")
        .withArgs(surmaAdmin.address);
      await expect(register("HALDA", Kind.None, outsider.address, wallet)).to.be.revertedWithCustomError(
        registry,
        "InvalidInstitution",
      );
      await expect(register("HALDA", Kind.CommercialBank, ethers.ZeroAddress, wallet)).to.be.revertedWithCustomError(
        registry,
        "InvalidAddress",
      );
    });

    it("lets only the registrar admit institutions", async () => {
      const { registry, outsider } = await loadFixture(deployNetwork);
      const wallet = ethers.Wallet.createRandom().address;

      await expect(
        as(registry, outsider).registerInstitution(
          code("HALDA"),
          Kind.CommercialBank,
          "Halda Bank",
          ascii("BD"),
          outsider.address,
          wallet,
        ),
      )
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, role("REGISTRAR_ROLE"));
    });

    it("suspends every account of an institution together with it", async () => {
      const { registry, supervisor, surmaAdmin, karim, outsider } = await loadFixture(deployNetwork);

      await expect(as(registry, outsider).setInstitutionActive(code("SURMA"), false))
        .to.be.revertedWithCustomError(registry, "NotAuthorised")
        .withArgs(outsider.address);

      await expect(as(registry, supervisor).setInstitutionActive(code("SURMA"), false))
        .to.emit(registry, "InstitutionStatusChanged")
        .withArgs(code("SURMA"), false, supervisor.address);

      expect(await registry.isEligible(karim.address)).to.equal(false);
      await expect(registry.policyOf(karim.address))
        .to.be.revertedWithCustomError(registry, "InstitutionInactive")
        .withArgs(code("SURMA"));
      await expect(
        as(registry, surmaAdmin).openAccount(outsider.address, Tier.Full, identityRef),
      ).to.be.revertedWithCustomError(registry, "InstitutionInactive");

      await registry.setInstitutionActive(code("SURMA"), true);
      expect(await registry.isEligible(karim.address)).to.equal(true);
    });

    it("moves the authority when the administrator key is rotated", async () => {
      const { registry, surmaAdmin, outsider, workers } = await loadFixture(deployNetwork);
      const wallet = workers[9].address;

      await expect(registry.setInstitutionAdmin(code("SURMA"), outsider.address))
        .to.emit(registry, "InstitutionAdminChanged")
        .withArgs(code("SURMA"), surmaAdmin.address, outsider.address);

      await expect(as(registry, surmaAdmin).closeAccount(wallet))
        .to.be.revertedWithCustomError(registry, "NotInstitutionAdmin")
        .withArgs(surmaAdmin.address);
      expect(await registry.institutionOfAdmin(outsider.address)).to.equal(code("SURMA"));
      await expect(registry.setInstitutionAdmin(code("NOBODY"), surmaAdmin.address))
        .to.be.revertedWithCustomError(registry, "UnknownInstitution")
        .withArgs(code("NOBODY"));
    });
  });

  describe("accounts", () => {
    it("opens a customer account under the caller's institution", async () => {
      const { registry, surmaAdmin, outsider } = await loadFixture(deployNetwork);

      await expect(as(registry, surmaAdmin).openAccount(outsider.address, Tier.Full, identityRef))
        .to.emit(registry, "AccountOpened")
        .withArgs(outsider.address, code("SURMA"), Tier.Full, identityRef);

      const account = await registry.account(outsider.address);
      expect(account.institution).to.equal(code("SURMA"));
      expect(account.tier).to.equal(Tier.Full);
      expect(account.status).to.equal(AccountStatus.Active);
      expect(account.identityRef).to.equal(identityRef);
    });

    it("refuses tiers reserved to the network, duplicates and callers that sponsor nothing", async () => {
      const { registry, surmaAdmin, karim, outsider } = await loadFixture(deployNetwork);

      for (const tier of [Tier.None, Tier.Institution, Tier.System]) {
        await expect(as(registry, surmaAdmin).openAccount(outsider.address, tier, identityRef))
          .to.be.revertedWithCustomError(registry, "InvalidTier")
          .withArgs(tier);
      }
      await expect(as(registry, surmaAdmin).openAccount(karim.address, Tier.Full, identityRef))
        .to.be.revertedWithCustomError(registry, "AccountExists")
        .withArgs(karim.address);
      await expect(as(registry, outsider).openAccount(outsider.address, Tier.Full, identityRef))
        .to.be.revertedWithCustomError(registry, "NotInstitutionAdmin")
        .withArgs(outsider.address);
    });

    it("lets only the sponsoring institution change a tier", async () => {
      const { registry, sanguAdmin, surmaAdmin, rahima } = await loadFixture(deployNetwork);

      await expect(as(registry, surmaAdmin).changeTier(rahima.address, Tier.Full))
        .to.be.revertedWithCustomError(registry, "NotAuthorised")
        .withArgs(surmaAdmin.address);
      await expect(as(registry, sanguAdmin).changeTier(rahima.address, Tier.System))
        .to.be.revertedWithCustomError(registry, "InvalidTier")
        .withArgs(Tier.System);

      await expect(as(registry, sanguAdmin).changeTier(rahima.address, Tier.Full))
        .to.emit(registry, "AccountTierChanged")
        .withArgs(rahima.address, Tier.Basic, Tier.Full);
      expect((await registry.policyOf(rahima.address)).perTransaction).to.equal(LIMITS.full.perTransaction);
    });

    it("freezes and unfreezes through the sponsor or the supervisor", async () => {
      const { registry, supervisor, sanguAdmin, surmaAdmin, rahima } = await loadFixture(deployNetwork);
      const reason = ethers.id("case-2026-0041");

      await expect(as(registry, surmaAdmin).freezeAccount(rahima.address, reason)).to.be.revertedWithCustomError(
        registry,
        "NotAuthorised",
      );

      await expect(as(registry, supervisor).freezeAccount(rahima.address, reason))
        .to.emit(registry, "AccountStatusChanged")
        .withArgs(rahima.address, AccountStatus.Frozen, reason, supervisor.address);
      expect(await registry.isEligible(rahima.address)).to.equal(false);
      await expect(registry.policyOf(rahima.address))
        .to.be.revertedWithCustomError(registry, "AccountNotActive")
        .withArgs(rahima.address, AccountStatus.Frozen);
      await expect(as(registry, supervisor).freezeAccount(rahima.address, reason))
        .to.be.revertedWithCustomError(registry, "InvalidStatusChange")
        .withArgs(rahima.address, AccountStatus.Frozen);

      await as(registry, sanguAdmin).unfreezeAccount(rahima.address);
      expect(await registry.isEligible(rahima.address)).to.equal(true);
    });

    it("closes an account for good", async () => {
      const { registry, supervisor, sanguAdmin, rahima } = await loadFixture(deployNetwork);

      await as(registry, sanguAdmin).closeAccount(rahima.address);

      expect((await registry.account(rahima.address)).status).to.equal(AccountStatus.Closed);
      await expect(as(registry, supervisor).unfreezeAccount(rahima.address))
        .to.be.revertedWithCustomError(registry, "InvalidStatusChange")
        .withArgs(rahima.address, AccountStatus.Closed);
      await expect(as(registry, sanguAdmin).closeAccount(rahima.address)).to.be.revertedWithCustomError(
        registry,
        "InvalidStatusChange",
      );
      await expect(as(registry, sanguAdmin).openAccount(rahima.address, Tier.Basic, identityRef))
        .to.be.revertedWithCustomError(registry, "AccountExists")
        .withArgs(rahima.address);
    });

    it("reports an unknown wallet as ineligible", async () => {
      const { registry, supervisor, outsider } = await loadFixture(deployNetwork);

      expect(await registry.isEligible(outsider.address)).to.equal(false);
      await expect(registry.policyOf(outsider.address))
        .to.be.revertedWithCustomError(registry, "AccountNotActive")
        .withArgs(outsider.address, AccountStatus.None);
      await expect(as(registry, supervisor).freezeAccount(outsider.address, ethers.ZeroHash))
        .to.be.revertedWithCustomError(registry, "UnknownAccount")
        .withArgs(outsider.address);
    });
  });

  describe("policy", () => {
    it("applies the limits of the account's tier", async () => {
      const { registry, rahima, karim, shop } = await loadFixture(deployNetwork);

      expect((await registry.policyOf(rahima.address)).maxBalance).to.equal(LIMITS.basic.maxBalance);
      expect((await registry.policyOf(karim.address)).dailyOutflow).to.equal(LIMITS.full.dailyOutflow);
      expect((await registry.policyOf(shop.address)).perTransaction).to.equal(0n);
    });

    it("lets only the policy role change limits", async () => {
      const { registry, outsider } = await loadFixture(deployNetwork);
      const limits = { perTransaction: taka(10_000), dailyOutflow: taka(20_000), maxBalance: taka(100_000) };

      await expect(as(registry, outsider).setTierLimits(Tier.Basic, limits)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
      await expect(registry.setTierLimits(Tier.None, limits)).to.be.revertedWithCustomError(registry, "InvalidTier");

      await expect(registry.setTierLimits(Tier.Basic, limits))
        .to.emit(registry, "TierLimitsUpdated")
        .withArgs(Tier.Basic, limits.perTransaction, limits.dailyOutflow, limits.maxBalance);
      expect((await registry.tierLimits(Tier.Basic)).dailyOutflow).to.equal(limits.dailyOutflow);
    });
  });
});
