import fs from "node:fs";

import { type ContractName, abis } from "@takarail/sdk";
import { type Abi, type AbiEvent, type Address, createPublicClient, defineChain, getAddress, http } from "viem";

import { config } from "../config";

export interface Deployment {
  chainId: number;
  startBlock: number;
  contracts: Record<ContractName, Address>;
}

function loadDeployment(): Deployment {
  const file = config.chain.deploymentFile;
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run "pnpm deploy:local" first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
  if (deployment.chainId !== config.chain.id) {
    throw new Error(`Deployment is for chain ${deployment.chainId}, the API is configured for ${config.chain.id}`);
  }
  return deployment;
}

export const deployment = loadDeployment();

export const chain = defineChain({
  id: config.chain.id,
  name: "TakaRail",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.chain.rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(config.chain.rpcUrl), pollingInterval: 200 });

/** Address and ABI of each contract, ready to spread into a viem call. */
export const contracts = {
  registry: { address: deployment.contracts.registry, abi: abis.registry },
  token: { address: deployment.contracts.token, abi: abis.token },
  controller: { address: deployment.contracts.controller, abi: abis.controller },
  paymentSwitch: { address: deployment.contracts.paymentSwitch, abi: abis.paymentSwitch },
  gateway: { address: deployment.contracts.gateway, abi: abis.gateway },
  hub: { address: deployment.contracts.hub, abi: abis.hub },
} as const;

const namesByAddress = new Map<string, ContractName>(
  (Object.entries(deployment.contracts) as [ContractName, Address][]).map(([name, address]) => [
    address.toLowerCase(),
    name,
  ]),
);

/** Name of the contract deployed at `address`, if it is one of ours. */
export const contractNameOf = (address: string) => namesByAddress.get(address.toLowerCase());

/** Module wallets hold funds in transit; reports label them instead of showing a bare address. */
export const MODULE_LABELS: Record<ContractName, string> = {
  registry: "Participant registry",
  token: "Tokenised Taka",
  controller: "Reserve controller",
  paymentSwitch: "Payment switch",
  gateway: "Remittance gateway",
  hub: "Disbursement hub",
};

/**
 * Every custom error of every contract. A call into the token can revert inside the registry or a
 * settlement module, so reverts are decoded against the whole set.
 */
export const settlementErrors: Abi = (() => {
  const seen = new Map<string, Abi[number]>();
  for (const abi of Object.values(abis) as Abi[]) {
    for (const item of abi) {
      if (item.type === "error") seen.set(`${item.name}(${item.inputs.map((input) => input.type).join(",")})`, item);
    }
  }
  return [...seen.values()];
})();

export const eventsOf = (name: ContractName) =>
  (abis[name] as Abi).filter((item): item is AbiEvent => item.type === "event");

export const allAddresses = Object.values(deployment.contracts).map((address) => getAddress(address));
