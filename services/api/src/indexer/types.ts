import type { ContractName } from "@takarail/sdk";
import type { Hex } from "viem";

import type { Queryable } from "../db/pool";

/** A decoded contract event with the block it was mined in. */
export interface ChainEvent<TArgs = Record<string, unknown>> {
  contract: ContractName;
  name: string;
  args: TArgs;
  blockNumber: bigint;
  /** Block timestamp as an ISO string. */
  blockTime: string;
  txHash: Hex;
  logIndex: number;
}

/** Applies one event to the read models, inside the transaction of its batch. */
export type Projection<TArgs = never> = (db: Queryable, event: ChainEvent<TArgs>) => Promise<void>;

export type ProjectionMap = Record<string, Projection>;

export const lower = (address: string) => address.toLowerCase();
