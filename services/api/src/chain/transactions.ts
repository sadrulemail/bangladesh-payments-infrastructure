import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type ContractFunctionArgs,
  type ContractFunctionName,
  ContractFunctionRevertedError,
  type Hex,
  createWalletClient,
  http,
} from "viem";

import { config } from "../config";
import { ContractRevert } from "../lib/errors";
import { chain, publicClient, settlementErrors } from "./network";

type Mutability = "nonpayable" | "payable";

export interface ContractCall<TAbi extends Abi, TName extends ContractFunctionName<TAbi, Mutability>> {
  address: Address;
  abi: TAbi;
  functionName: TName;
  args: ContractFunctionArgs<TAbi, Mutability, TName>;
}

export interface Receipt {
  txHash: Hex;
  blockNumber: bigint;
}

const walletClient = createWalletClient({ chain, transport: http(config.chain.rpcUrl) });

/** The network charges no gas, so transactions are sent at the configured price, zero by default. */
const fees = { maxFeePerGas: config.chain.gasPriceWei, maxPriorityFeePerGas: config.chain.gasPriceWei };

/** One transaction at a time per signer, so nonces never collide. */
const queues = new Map<Address, Promise<unknown>>();

function inTurn<T>(signer: Address, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(signer) ?? Promise.resolve();
  const next = previous.then(work, work);
  queues.set(
    signer,
    next.catch(() => undefined),
  );
  return next;
}

/** Turns a viem failure into a `ContractRevert` that names the contract error. */
function toContractRevert(error: unknown): unknown {
  if (!(error instanceof BaseError)) return error;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    const reason = revert.data?.errorName ?? revert.reason ?? "ExecutionReverted";
    return new ContractRevert(reason, revert.data?.args ?? []);
  }
  return error;
}

/**
 * Simulates a contract call, signs it with `signer`, submits it and waits for it to be mined.
 * A revert surfaces before anything is sent, with the contract's own error name.
 */
export function send<const TAbi extends Abi, TName extends ContractFunctionName<TAbi, Mutability>>(
  signer: Account,
  call: ContractCall<TAbi, TName>,
): Promise<Receipt> {
  return inTurn(signer.address, async () => {
    try {
      const { request } = await publicClient.simulateContract({
        account: signer,
        address: call.address,
        abi: [...call.abi, ...settlementErrors] as Abi,
        functionName: call.functionName as string,
        args: call.args as readonly unknown[],
        ...fees,
      });
      const txHash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new ContractRevert("TransactionFailed");
      return { txHash, blockNumber: receipt.blockNumber };
    } catch (error) {
      throw toContractRevert(error);
    }
  });
}
