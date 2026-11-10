/**
 * Deploys the TakaRail contracts and configures the reference network described in
 * `network/reference-network.json`: roles, institutions, policy, corridors, accounts and merchants.
 *
 *   pnpm deploy:local
 *
 * Writes the addresses to `deployments/<chainId>.json`, which the API reads at start-up.
 */
import fs from "node:fs";
import path from "node:path";

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { BaseContract, Contract, ContractTransactionResponse } from "ethers";
import { ethers, network } from "hardhat";

import reference from "../../network/reference-network.json";

const HOUR = 60 * 60;

const KINDS = [
  "None",
  "NetworkOperator",
  "SettlementBank",
  "CommercialBank",
  "MobileFinancialService",
  "PaymentServiceProvider",
  "ExchangeHouse",
  "Treasury",
];
const TIERS = ["None", "Basic", "Full", "Merchant", "Corporate", "Institution", "System"];

const code = (text: string) => ethers.encodeBytes32String(text);
const ascii = (text: string) => ethers.hexlify(ethers.toUtf8Bytes(text));
const taka = (amount: string) => ethers.parseUnits(amount, 2);
const rate = (value: string) => ethers.parseUnits(value, 6);
const enumIndex = (values: string[], name: string) => {
  const index = values.indexOf(name);
  if (index < 1) throw new Error(`Unknown value "${name}"`);
  return index;
};

async function confirmed(transaction: Promise<ContractTransactionResponse>) {
  await (await transaction).wait();
}

const as = (contract: BaseContract, signer: HardhatEthersSigner) => contract.connect(signer) as Contract;

async function main() {
  const signers = await ethers.getSigners();
  const governance = signers[0];
  const signerAt = (index: number) => {
    const signer = signers[index];
    if (!signer) throw new Error(`No wallet at key index ${index}`);
    return signer;
  };
  const { policy } = reference;
  const startBlock = await ethers.provider.getBlockNumber();

  console.log(`Deploying to ${network.name} as ${governance.address}`);

  const deploy = async (name: string, args: unknown[]) => {
    const contract = await ethers.deployContract(name, args, governance);
    await contract.waitForDeployment();
    console.log(`  ${name.padEnd(20)} ${contract.target}`);
    return contract;
  };

  const settlementAccount = (id: string) => {
    const institution = reference.institutions.find((item) => item.id === id);
    if (!institution) throw new Error(`Unknown institution ${id}`);
    return signerAt(institution.settlementIndex).address;
  };

  const registry = await deploy("ParticipantRegistry", [governance.address]);
  const token = await deploy("TokenisedTaka", [governance.address, registry.target]);
  const controller = await deploy("ReserveController", [
    governance.address,
    token.target,
    registry.target,
    policy.reserveController.maxStatementAgeHours * HOUR,
  ]);
  const paymentSwitch = await deploy("PaymentSwitch", [
    governance.address,
    token.target,
    registry.target,
    settlementAccount("NETWORK"),
    policy.paymentSwitch.defaultFeeBps,
    policy.paymentSwitch.acquirerShareBps,
  ]);
  const gateway = await deploy("RemittanceGateway", [
    governance.address,
    token.target,
    registry.target,
    {
      incentiveBps: policy.remittanceGateway.incentiveBps,
      rateBandBps: policy.remittanceGateway.rateBandBps,
      rateValidity: policy.remittanceGateway.rateValidityHours * HOUR,
      reviewWindow: policy.remittanceGateway.reviewWindowHours * HOUR,
      screeningThreshold: taka(policy.remittanceGateway.screeningThreshold),
    },
  ]);
  const hub = await deploy("DisbursementHub", [token.target, registry.target]);

  const contracts: Record<string, Contract> = { registry, token, controller, paymentSwitch, gateway, hub };

  console.log("Granting roles");
  await confirmed(token.grantRole(ethers.id("MINTER_ROLE"), controller.target));
  for (const officer of reference.officers) {
    for (const grant of officer.chainRoles) {
      const [target, roleName] = grant.split(":");
      await confirmed(contracts[target].grantRole(ethers.id(roleName), signerAt(officer.keyIndex).address));
    }
  }

  console.log("Registering institutions");
  for (const institution of reference.institutions) {
    await confirmed(
      registry.registerInstitution(
        code(institution.id),
        enumIndex(KINDS, institution.kind),
        institution.name,
        ascii(institution.country),
        signerAt(institution.adminIndex).address,
        signerAt(institution.settlementIndex).address,
      ),
    );
  }
  for (const module of [controller, paymentSwitch, gateway, hub]) {
    await confirmed(registry.registerSystemAccount(code("NETWORK"), module.target));
  }

  console.log("Setting policy");
  for (const [tier, limits] of Object.entries(policy.tierLimits)) {
    await confirmed(
      registry.setTierLimits(enumIndex(TIERS, tier), {
        perTransaction: taka(limits.perTransaction),
        dailyOutflow: taka(limits.dailyOutflow),
        maxBalance: taka(limits.maxBalance),
      }),
    );
  }
  for (const fee of policy.paymentSwitch.categoryFees) {
    await confirmed(paymentSwitch.setCategoryFee(fee.categoryCode, true, fee.feeBps));
  }

  console.log("Opening corridors");
  const ratePublisher = reference.officers.find((officer) =>
    officer.chainRoles.includes("gateway:RATE_PUBLISHER_ROLE"),
  );
  if (!ratePublisher) throw new Error("No officer holds the rate publisher role");
  for (const corridor of reference.corridors) {
    await confirmed(
      gateway.configureCorridor(code(corridor.id), ascii(corridor.currency), taka(corridor.maxAmount), true),
    );
    for (const originator of corridor.originators) {
      await confirmed(gateway.setOriginator(code(corridor.id), code(originator), true));
    }
    await confirmed(
      as(gateway, signerAt(ratePublisher.keyIndex)).publishRate(code(corridor.id), rate(corridor.referenceRate)),
    );
  }

  console.log("Opening accounts");
  const adminOf = (id: string) => {
    const institution = reference.institutions.find((item) => item.id === id);
    if (!institution) throw new Error(`Unknown institution ${id}`);
    return signerAt(institution.adminIndex);
  };
  for (const account of reference.accounts) {
    const holder = signerAt(account.keyIndex).address;
    const identityRef = ethers.solidityPackedKeccak256(["string", "address"], [account.institution, holder]);
    await confirmed(
      as(registry, adminOf(account.institution)).openAccount(holder, enumIndex(TIERS, account.tier), identityRef),
    );
  }

  console.log("Registering merchants");
  for (const merchant of reference.merchants) {
    const account = reference.accounts.find((item) => item.keyIndex === merchant.accountIndex);
    if (!account) throw new Error(`Merchant ${merchant.id} has no account`);
    await confirmed(
      as(paymentSwitch, adminOf(account.institution)).registerMerchant(
        code(merchant.id),
        signerAt(merchant.accountIndex).address,
        merchant.categoryCode,
      ),
    );
  }

  const { chainId } = await ethers.provider.getNetwork();
  const deployment = {
    chainId: Number(chainId),
    startBlock: startBlock + 1,
    contracts: Object.fromEntries(Object.entries(contracts).map(([name, contract]) => [name, contract.target])),
  };
  const directory = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${deployment.chainId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
