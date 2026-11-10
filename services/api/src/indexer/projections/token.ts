import { type Address, zeroAddress } from "viem";

import { postTransfer } from "../../ledger/posting";
import { type Projection, type ProjectionMap, lower } from "../types";

/** Records the movement and posts it to the ledger in the same transaction. */
const transfer: Projection<{ from: Address; to: Address; value: bigint }> = async (db, event) => {
  const { args, blockNumber, blockTime, txHash, logIndex } = event;
  await db.query(
    `INSERT INTO token_transfers (block_number, block_time, tx_hash, log_index, from_address, to_address, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [blockNumber, blockTime, txHash, logIndex, lower(args.from), lower(args.to), args.value],
  );

  if (args.value === 0n) return;
  await postTransfer(db, {
    from: args.from === zeroAddress ? null : lower(args.from),
    to: args.to === zeroAddress ? null : lower(args.to),
    amount: args.value,
    blockNumber,
    postedAt: blockTime,
    txHash,
    logIndex,
  });
};

export const tokenProjections = { Transfer: transfer } as ProjectionMap;
