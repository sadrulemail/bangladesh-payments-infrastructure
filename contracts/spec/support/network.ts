import type { Contract, Signer } from "ethers";
import { ethers } from "hardhat";

export const DAY = 24 * 60 * 60;
export const DHAKA_UTC_OFFSET = 6 * 60 * 60;
export const RATE_SCALE = 1_000_000n;

export enum Kind {
  None,
  NetworkOperator,
  SettlementBank,
  CommercialBank,
  MobileFinancialService,
  PaymentServiceProvider,
  ExchangeHouse,
  Treasury,
}

export enum Tier {
  None,
  Basic,
  Full,
  Merchant,
  Corporate,
  Institution,
  System,
}

export enum AccountStatus {
  None,
  Active,
  Frozen,
  Closed,
}

/** Short code as bytes32, for instance an institution or corridor id. */
export const code = (text: string) => ethers.encodeBytes32String(text);

/** ASCII text as fixed-size bytes, for instance a currency (3) or purpose code (4). */
export const ascii = (text: string) => ethers.hexlify(ethers.toUtf8Bytes(text));

/** Taka amount in poisha. */
export const taka = (amount: number | string) => ethers.parseUnits(String(amount), 2);

/** Exchange rate scaled the way the gateway expects it. */
export const rate = (value: number | string) => ethers.parseUnits(String(value), 6);

export const role = (name: string) => ethers.id(name);

/** Binds a contract to another signer. */
export const as = (contract: Contract, signer: Signer) => contract.connect(signer) as Contract;

/** Timestamp of the block at the head of the chain. */
export async function chainTime(): Promise<number> {
  const block = await ethers.provider.getBlock(await ethers.provider.getBlockNumber());
  if (!block) throw new Error("The chain has no block yet");
  return block.timestamp;
}

/** First second of the next business day in Dhaka. */
export async function nextDhakaMidnight(): Promise<number> {
  const now = await chainTime();
  const day = Math.floor((now + DHAKA_UTC_OFFSET) / DAY);
  return (day + 1) * DAY - DHAKA_UTC_OFFSET;
}

export const LIMITS = {
  basic: { perTransaction: taka(25_000), dailyOutflow: taka(50_000), maxBalance: taka(300_000) },
  full: { perTransaction: taka(500_000), dailyOutflow: taka(1_000_000), maxBalance: 0n },
};

export const GATEWAY_POLICY = {
  incentiveBps: 250,
  rateBandBps: 150,
  rateValidity: DAY,
  reviewWindow: 3 * DAY,
  screeningThreshold: taka(150_000),
};

export const AED_RATE = rate("33.25");

/**
 * Deploys the whole network with a small set of institutions and customers:
 * a settlement bank, a commercial bank, a mobile financial service, an exchange house and the Treasury.
 */
export async function deployNetwork() {
  const signers = await ethers.getSigners();
  const [
    governance,
    supervisor,
    maker,
    checker,
    auditor,
    compliance,
    feeCollector,
    teestaAdmin,
    teestaSettlement,
    surmaAdmin,
    surmaSettlement,
    sanguAdmin,
    sanguSettlement,
    dhowAdmin,
    dhowSettlement,
    treasuryAdmin,
    treasurySettlement,
    rahima,
    karim,
    nusrat,
    shop,
    factory,
    outsider,
  ] = signers;
  const workers = signers.slice(30, 40);

  const registry = await ethers.deployContract("ParticipantRegistry", [governance.address]);
  const token = await ethers.deployContract("TokenisedTaka", [governance.address, registry.target]);
  const controller = await ethers.deployContract("ReserveController", [
    governance.address,
    token.target,
    registry.target,
    2 * DAY,
  ]);
  const paymentSwitch = await ethers.deployContract("PaymentSwitch", [
    governance.address,
    token.target,
    registry.target,
    feeCollector.address,
    100,
    7_000,
  ]);
  const gateway = await ethers.deployContract("RemittanceGateway", [
    governance.address,
    token.target,
    registry.target,
    GATEWAY_POLICY,
  ]);
  const hub = await ethers.deployContract("DisbursementHub", [token.target, registry.target]);

  await registry.grantRole(role("REGISTRAR_ROLE"), governance.address);
  await registry.grantRole(role("POLICY_ROLE"), governance.address);
  await registry.grantRole(role("SUPERVISOR_ROLE"), supervisor.address);
  await token.grantRole(role("MINTER_ROLE"), controller.target);
  await token.grantRole(role("PAUSER_ROLE"), supervisor.address);
  await token.grantRole(role("ENFORCEMENT_ROLE"), supervisor.address);
  await controller.grantRole(role("MAKER_ROLE"), maker.address);
  await controller.grantRole(role("CHECKER_ROLE"), checker.address);
  await controller.grantRole(role("AUDITOR_ROLE"), auditor.address);
  await paymentSwitch.grantRole(role("FEE_ROLE"), governance.address);
  await gateway.grantRole(role("CORRIDOR_ROLE"), governance.address);
  await gateway.grantRole(role("RATE_PUBLISHER_ROLE"), maker.address);
  await gateway.grantRole(role("COMPLIANCE_ROLE"), compliance.address);

  const institutions: [string, Kind, string, string, Signer, Signer][] = [
    ["NETWORK", Kind.NetworkOperator, "TakaRail Network Operations", "BD", governance, feeCollector],
    ["TEESTA", Kind.SettlementBank, "Teesta Settlement Bank", "BD", teestaAdmin, teestaSettlement],
    ["SURMA", Kind.CommercialBank, "Surma Commercial Bank", "BD", surmaAdmin, surmaSettlement],
    ["SANGU", Kind.MobileFinancialService, "Sangu Pay", "BD", sanguAdmin, sanguSettlement],
    ["DHOW", Kind.ExchangeHouse, "Dhow Exchange House", "AE", dhowAdmin, dhowSettlement],
    ["TREASURY", Kind.Treasury, "Government Treasury", "BD", treasuryAdmin, treasurySettlement],
  ];
  for (const [id, kind, name, country, admin, settlement] of institutions) {
    await registry.registerInstitution(
      code(id),
      kind,
      name,
      ascii(country),
      await admin.getAddress(),
      await settlement.getAddress(),
    );
  }
  for (const module of [controller, paymentSwitch, gateway, hub]) {
    await registry.registerSystemAccount(code("NETWORK"), module.target);
  }

  await registry.setTierLimits(Tier.Basic, LIMITS.basic);
  await registry.setTierLimits(Tier.Full, LIMITS.full);

  const identity = (name: string) => ethers.id(`kyc:${name}`);
  await as(registry, sanguAdmin).openAccount(rahima.address, Tier.Basic, identity("rahima"));
  await as(registry, surmaAdmin).openAccount(karim.address, Tier.Full, identity("karim"));
  await as(registry, surmaAdmin).openAccount(nusrat.address, Tier.Full, identity("nusrat"));
  await as(registry, surmaAdmin).openAccount(shop.address, Tier.Merchant, identity("shop"));
  await as(registry, surmaAdmin).openAccount(factory.address, Tier.Corporate, identity("factory"));
  for (const [index, worker] of workers.entries()) {
    await as(registry, sanguAdmin).openAccount(worker.address, Tier.Basic, identity(`worker-${index}`));
  }

  let fundingSequence = 0;

  /** Publishes a reserve statement dated now. */
  async function publishReserve(balance: bigint) {
    await as(controller, auditor).publishReserveStatement(await chainTime(), balance, ethers.id("statement"));
  }

  /** Issues tBDT to an institution through the maker-checker flow. */
  async function issue(institution: string, amount: bigint) {
    const requestId = await controller.issuanceCount();
    const fundingRef = ethers.id(`funding:${institution}:${fundingSequence++}`);
    await as(controller, maker).requestIssuance(code(institution), amount, fundingRef);
    await as(controller, checker).approveIssuance(requestId);
    return requestId as bigint;
  }

  /** Funds a module with an instruction in one transaction. */
  function instruct(from: Signer, module: Contract, amount: bigint, instruction: string) {
    return as(token, from)["transferAndCall(address,uint256,bytes)"](module.target, amount, instruction);
  }

  await publishReserve(taka(1_000_000_000));
  await issue("SURMA", taka(5_000_000));
  await issue("SANGU", taka(5_000_000));
  await issue("DHOW", taka(10_000_000));
  await issue("TREASURY", taka(1_000_000));

  await as(token, surmaSettlement).transfer(karim.address, taka(100_000));
  await as(token, surmaSettlement).transfer(nusrat.address, taka(50_000));
  await as(token, surmaSettlement).transfer(factory.address, taka(1_000_000));
  await as(token, sanguSettlement).transfer(rahima.address, taka(20_000));

  await as(paymentSwitch, surmaAdmin).registerMerchant(code("NAKSHI-01"), shop.address, 5411);

  await gateway.configureCorridor(code("AE-BD"), ascii("AED"), taka(500_000), true);
  await gateway.setOriginator(code("AE-BD"), code("DHOW"), true);
  await as(gateway, maker).publishRate(code("AE-BD"), AED_RATE);
  await instruct(treasurySettlement, gateway, taka(100_000), await gateway.encodeIncentiveFunding());

  return {
    registry,
    token,
    controller,
    paymentSwitch,
    gateway,
    hub,
    governance,
    supervisor,
    maker,
    checker,
    auditor,
    compliance,
    feeCollector,
    teestaAdmin,
    teestaSettlement,
    surmaAdmin,
    surmaSettlement,
    sanguAdmin,
    sanguSettlement,
    dhowAdmin,
    dhowSettlement,
    treasuryAdmin,
    treasurySettlement,
    rahima,
    karim,
    nusrat,
    shop,
    factory,
    outsider,
    workers,
    publishReserve,
    issue,
    instruct,
  };
}

export type Network = Awaited<ReturnType<typeof deployNetwork>>;
