import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { LIMITS, Tier, as, ascii, code, deployNetwork, role, taka } from "./support/network";

enum PaymentKind {
  Merchant,
  Person,
}

const NAKSHI = code("NAKSHI-01");
const GROCERY_MCC = 5411;

describe("PaymentSwitch", () => {
  describe("merchants", () => {
    it("lets an acquirer onboard a merchant account it sponsors", async () => {
      const { paymentSwitch, registry, surmaAdmin, outsider } = await loadFixture(deployNetwork);
      await as(registry, surmaAdmin).openAccount(outsider.address, Tier.Merchant, ethers.id("kyc:pharmacy"));

      await expect(as(paymentSwitch, surmaAdmin).registerMerchant(code("SHAPLA-02"), outsider.address, 5912))
        .to.emit(paymentSwitch, "MerchantRegistered")
        .withArgs(code("SHAPLA-02"), code("SURMA"), outsider.address, 5912);

      const merchant = await paymentSwitch.merchant(code("SHAPLA-02"));
      expect(merchant.acquirer).to.equal(code("SURMA"));
      expect(merchant.active).to.equal(true);
    });

    it("refuses accounts of another tier or institution, duplicates and callers that sponsor nothing", async () => {
      const { paymentSwitch, surmaAdmin, sanguAdmin, shop, karim, outsider } = await loadFixture(deployNetwork);

      await expect(as(paymentSwitch, surmaAdmin).registerMerchant(code("KARIM-01"), karim.address, GROCERY_MCC))
        .to.be.revertedWithCustomError(paymentSwitch, "MerchantAccountNotEligible")
        .withArgs(karim.address);
      await expect(as(paymentSwitch, sanguAdmin).registerMerchant(code("NAKSHI-02"), shop.address, GROCERY_MCC))
        .to.be.revertedWithCustomError(paymentSwitch, "MerchantAccountNotEligible")
        .withArgs(shop.address);
      await expect(as(paymentSwitch, surmaAdmin).registerMerchant(NAKSHI, shop.address, GROCERY_MCC))
        .to.be.revertedWithCustomError(paymentSwitch, "MerchantExists")
        .withArgs(NAKSHI);
      await expect(as(paymentSwitch, outsider).registerMerchant(code("NAKSHI-03"), shop.address, GROCERY_MCC))
        .to.be.revertedWithCustomError(paymentSwitch, "NotInstitutionAdmin")
        .withArgs(outsider.address);
    });

    it("stops paying a merchant its acquirer has suspended", async () => {
      const { paymentSwitch, surmaAdmin, sanguAdmin, karim, instruct } = await loadFixture(deployNetwork);
      const instruction = await paymentSwitch.encodeMerchantPayment(NAKSHI, ethers.ZeroHash);

      await expect(as(paymentSwitch, sanguAdmin).setMerchantActive(NAKSHI, false))
        .to.be.revertedWithCustomError(paymentSwitch, "NotAcquirer")
        .withArgs(sanguAdmin.address);
      await expect(as(paymentSwitch, surmaAdmin).setMerchantActive(NAKSHI, false))
        .to.emit(paymentSwitch, "MerchantStatusChanged")
        .withArgs(NAKSHI, false);

      await expect(instruct(karim, paymentSwitch, taka(500), instruction))
        .to.be.revertedWithCustomError(paymentSwitch, "MerchantInactive")
        .withArgs(NAKSHI);
      await expect(
        instruct(
          karim,
          paymentSwitch,
          taka(500),
          await paymentSwitch.encodeMerchantPayment(code("GHOST"), ethers.ZeroHash),
        ),
      )
        .to.be.revertedWithCustomError(paymentSwitch, "UnknownMerchant")
        .withArgs(code("GHOST"));
    });
  });

  describe("merchant payments", () => {
    it("pays the merchant and splits the fee between acquirer and network in one transaction", async () => {
      const { paymentSwitch, token, rahima, shop, surmaSettlement, feeCollector, instruct } =
        await loadFixture(deployNetwork);
      const invoiceRef = ethers.id("INV-2026-000451");
      const paymentId = await paymentSwitch.paymentCount();
      const instruction = await paymentSwitch.encodeMerchantPayment(NAKSHI, invoiceRef);

      // 1% of 2,450.00 is 24.50: 70% to the acquirer, the rest to the network.
      const payment = instruct(rahima, paymentSwitch, taka(2_450), instruction);
      await expect(payment).to.changeTokenBalances(
        token,
        [rahima, shop, surmaSettlement, feeCollector, paymentSwitch],
        [-taka(2_450), taka("2425.50"), taka("17.15"), taka("7.35"), 0n],
      );
      await expect(payment)
        .to.emit(paymentSwitch, "MerchantPaymentSettled")
        .withArgs(
          paymentId,
          NAKSHI,
          rahima.address,
          shop.address,
          taka(2_450),
          taka("17.15"),
          taka("7.35"),
          invoiceRef,
        );

      const record = await paymentSwitch.payment(paymentId);
      expect(record.kind).to.equal(PaymentKind.Merchant);
      expect(record.payer).to.equal(rahima.address);
      expect(record.fee).to.equal(taka("24.50"));
      expect(await paymentSwitch.isInvoicePaid(NAKSHI, invoiceRef)).to.equal(true);
    });

    it("pays an invoice once and lets a static code be paid again", async () => {
      const { paymentSwitch, karim, nusrat, instruct } = await loadFixture(deployNetwork);
      const invoiceRef = ethers.id("INV-2026-000452");
      const invoice = await paymentSwitch.encodeMerchantPayment(NAKSHI, invoiceRef);
      const staticCode = await paymentSwitch.encodeMerchantPayment(NAKSHI, ethers.ZeroHash);

      await instruct(karim, paymentSwitch, taka(900), invoice);
      await expect(instruct(nusrat, paymentSwitch, taka(900), invoice))
        .to.be.revertedWithCustomError(paymentSwitch, "InvoiceAlreadyPaid")
        .withArgs(NAKSHI, invoiceRef);

      await instruct(karim, paymentSwitch, taka(120), staticCode);
      await expect(instruct(karim, paymentSwitch, taka(120), staticCode)).to.not.be.reverted;
    });

    it("rounds the fee down to the poisha", async () => {
      const { paymentSwitch, token, karim, shop, instruct } = await loadFixture(deployNetwork);
      const instruction = await paymentSwitch.encodeMerchantPayment(NAKSHI, ethers.ZeroHash);

      // 1% of 0.99 is below one poisha, so no fee is taken.
      await expect(instruct(karim, paymentSwitch, taka("0.99"), instruction)).to.changeTokenBalance(
        token,
        shop,
        taka("0.99"),
      );
      expect(await paymentSwitch.quoteFee(NAKSHI, taka("0.99"))).to.deep.equal([0n, 0n]);
    });

    it("applies the sender's limits to the payment", async () => {
      const { paymentSwitch, token, sanguSettlement, rahima, instruct } = await loadFixture(deployNetwork);
      await as(token, sanguSettlement).transfer(rahima.address, taka(40_000));
      const instruction = await paymentSwitch.encodeMerchantPayment(NAKSHI, ethers.ZeroHash);

      await expect(
        instruct(rahima, paymentSwitch, LIMITS.basic.perTransaction + 1n, instruction),
      ).to.be.revertedWithCustomError(token, "TransactionLimitExceeded");
    });
  });

  describe("fee schedule", () => {
    it("charges the fee of the merchant's category when one is set", async () => {
      const { paymentSwitch, token, karim, shop, instruct } = await loadFixture(deployNetwork);
      const instruction = await paymentSwitch.encodeMerchantPayment(NAKSHI, ethers.ZeroHash);

      await expect(paymentSwitch.setCategoryFee(GROCERY_MCC, true, 0))
        .to.emit(paymentSwitch, "CategoryFeeChanged")
        .withArgs(GROCERY_MCC, true, 0);
      expect(await paymentSwitch.feeBpsFor(GROCERY_MCC)).to.equal(0n);
      await expect(instruct(karim, paymentSwitch, taka(1_000), instruction)).to.changeTokenBalance(
        token,
        shop,
        taka(1_000),
      );

      await paymentSwitch.setCategoryFee(GROCERY_MCC, false, 0);
      expect(await paymentSwitch.feeBpsFor(GROCERY_MCC)).to.equal(100n);
    });

    it("keeps fees under the ceiling and the schedule in the hands of the fee role", async () => {
      const { paymentSwitch, karim, feeCollector } = await loadFixture(deployNetwork);

      await expect(paymentSwitch.setFeeSchedule(301, 7_000))
        .to.be.revertedWithCustomError(paymentSwitch, "FeeTooHigh")
        .withArgs(301);
      await expect(paymentSwitch.setFeeSchedule(100, 10_001))
        .to.be.revertedWithCustomError(paymentSwitch, "InvalidShare")
        .withArgs(10_001);
      await expect(paymentSwitch.setCategoryFee(GROCERY_MCC, true, 301)).to.be.revertedWithCustomError(
        paymentSwitch,
        "FeeTooHigh",
      );
      await expect(paymentSwitch.setFeeCollector(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        paymentSwitch,
        "InvalidAddress",
      );
      await expect(as(paymentSwitch, karim).setFeeSchedule(0, 0))
        .to.be.revertedWithCustomError(paymentSwitch, "AccessControlUnauthorizedAccount")
        .withArgs(karim.address, role("FEE_ROLE"));

      await expect(paymentSwitch.setFeeSchedule(50, 5_000))
        .to.emit(paymentSwitch, "FeeScheduleChanged")
        .withArgs(50, 5_000);
      expect(await paymentSwitch.feeCollector()).to.equal(feeCollector.address);
    });
  });

  describe("person-to-person transfers", () => {
    it("settles across institutions with a reference and a purpose, free of charge", async () => {
      const { paymentSwitch, token, karim, rahima, instruct } = await loadFixture(deployNetwork);
      const endToEndRef = ethers.id("E2E-20261110-000031");
      const paymentId = await paymentSwitch.paymentCount();
      const instruction = await paymentSwitch.encodePersonTransfer(rahima.address, endToEndRef, ascii("FAMI"));

      const transfer = instruct(karim, paymentSwitch, taka(5_000), instruction);
      await expect(transfer).to.changeTokenBalances(
        token,
        [karim, rahima, paymentSwitch],
        [-taka(5_000), taka(5_000), 0n],
      );
      await expect(transfer)
        .to.emit(paymentSwitch, "PersonTransferSettled")
        .withArgs(paymentId, karim.address, rahima.address, taka(5_000), endToEndRef, ascii("FAMI"));
      expect((await paymentSwitch.payment(paymentId)).kind).to.equal(PaymentKind.Person);
    });

    it("refuses a payee that is not eligible", async () => {
      const { paymentSwitch, registry, karim, outsider, instruct } = await loadFixture(deployNetwork);
      const instruction = await paymentSwitch.encodePersonTransfer(outsider.address, ethers.ZeroHash, ascii("FAMI"));

      await expect(instruct(karim, paymentSwitch, taka(100), instruction)).to.be.revertedWithCustomError(
        registry,
        "AccountNotActive",
      );
    });
  });

  describe("refunds", () => {
    async function paidInvoice() {
      const network = await loadFixture(deployNetwork);
      const { paymentSwitch, karim, instruct } = network;
      const paymentId: bigint = await paymentSwitch.paymentCount();
      await instruct(
        karim,
        paymentSwitch,
        taka(3_000),
        await paymentSwitch.encodeMerchantPayment(NAKSHI, ethers.id("INV-2026-000460")),
      );
      return { ...network, paymentId, refund: await paymentSwitch.encodeRefund(paymentId) };
    }

    it("returns money from the merchant to the payer, in part or in full", async () => {
      const { paymentSwitch, token, karim, shop, instruct, paymentId, refund } = await paidInvoice();

      const partial = instruct(shop, paymentSwitch, taka(1_000), refund);
      await expect(partial).to.changeTokenBalances(token, [shop, karim], [-taka(1_000), taka(1_000)]);
      await expect(partial)
        .to.emit(paymentSwitch, "PaymentRefunded")
        .withArgs(paymentId, karim.address, taka(1_000), taka(1_000));

      await instruct(shop, paymentSwitch, taka(1_970), refund);
      expect((await paymentSwitch.payment(paymentId)).refunded).to.equal(taka(2_970));
    });

    it("never refunds more than was paid", async () => {
      const { paymentSwitch, token, surmaSettlement, shop, instruct, paymentId, refund } = await paidInvoice();
      await as(token, surmaSettlement).transfer(shop.address, taka(5_000));

      await expect(instruct(shop, paymentSwitch, taka(3_001), refund))
        .to.be.revertedWithCustomError(paymentSwitch, "RefundExceedsPayment")
        .withArgs(paymentId, taka(3_001), taka(3_000));
    });

    it("accepts refunds from the merchant of the payment only", async () => {
      const { paymentSwitch, karim, nusrat, rahima, instruct, paymentId, refund } = await paidInvoice();

      await expect(instruct(nusrat, paymentSwitch, taka(100), refund))
        .to.be.revertedWithCustomError(paymentSwitch, "NotRefundable")
        .withArgs(paymentId);
      await expect(instruct(karim, paymentSwitch, taka(100), await paymentSwitch.encodeRefund(999)))
        .to.be.revertedWithCustomError(paymentSwitch, "UnknownPayment")
        .withArgs(999);

      const transferId = await paymentSwitch.paymentCount();
      await instruct(
        karim,
        paymentSwitch,
        taka(100),
        await paymentSwitch.encodePersonTransfer(rahima.address, ethers.ZeroHash, ascii("FAMI")),
      );
      await expect(instruct(rahima, paymentSwitch, taka(100), await paymentSwitch.encodeRefund(transferId)))
        .to.be.revertedWithCustomError(paymentSwitch, "NotRefundable")
        .withArgs(transferId);
    });
  });

  describe("instructions", () => {
    it("rejects an unknown instruction, an empty amount and a caller that is not the token", async () => {
      const { paymentSwitch, karim, instruct } = await loadFixture(deployNetwork);
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const unknown = coder.encode(["uint8", "bytes"], [9, "0x"]);

      await expect(instruct(karim, paymentSwitch, taka(10), unknown))
        .to.be.revertedWithCustomError(paymentSwitch, "UnknownInstruction")
        .withArgs(9);
      await expect(
        instruct(karim, paymentSwitch, 0n, await paymentSwitch.encodeMerchantPayment(NAKSHI, ethers.ZeroHash)),
      ).to.be.revertedWithCustomError(paymentSwitch, "InvalidAmount");
      await expect(as(paymentSwitch, karim).onTransferReceived(karim.address, karim.address, taka(10), unknown))
        .to.be.revertedWithCustomError(paymentSwitch, "UnauthorisedToken")
        .withArgs(karim.address);
    });
  });
});
