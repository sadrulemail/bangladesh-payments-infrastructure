/**
 * Event indexer. Follows the chain from the deployment block, decodes the events of the TakaRail
 * contracts and applies them to the read models and to the ledger.
 *
 * A batch of blocks is applied in one database transaction together with the cursor, so the read
 * models always describe the chain exactly up to the cursor block: a crash replays nothing twice and
 * skips nothing. The indexer stays `CONFIRMATIONS` blocks behind the head; on a network with
 * immediate finality that is zero and no rollback handling is needed.
 */
import { type ContractName, abis } from "@takarail/sdk";
import { type Abi, type Log, decodeEventLog } from "viem";

import { allAddresses, contractNameOf, deployment, publicClient } from "../chain/network";
import { config } from "../config";
import { type Queryable, pool, queryOne, transaction } from "../db/pool";
import { disbursementProjections } from "./projections/disbursements";
import { paymentProjections } from "./projections/payments";
import { registryProjections } from "./projections/registry";
import { remittanceProjections } from "./projections/remittances";
import { reserveProjections } from "./projections/reserve";
import { tokenProjections } from "./projections/token";
import type { ChainEvent, ProjectionMap } from "./types";

const BLOCKS_PER_BATCH = 500n;

const projections: Record<ContractName, ProjectionMap> = {
  registry: registryProjections,
  token: tokenProjections,
  controller: reserveProjections,
  paymentSwitch: paymentProjections,
  gateway: remittanceProjections,
  hub: disbursementProjections,
};

const toJson = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));

interface Waiter {
  block: bigint;
  resolve: () => void;
}

export class Indexer {
  private cursor = BigInt(deployment.startBlock) - 1n;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private waiters: Waiter[] = [];
  private stopped = true;

  /** Last block whose events are reflected in the read models. */
  get position(): bigint {
    return this.cursor;
  }

  async start(): Promise<void> {
    const saved = await queryOne<{ blockNumber: string }>(pool, "SELECT block_number FROM indexer_cursor WHERE id = 1");
    if (saved) this.cursor = BigInt(saved.blockNumber);
    this.stopped = false;
    await this.poll();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Resolves once the read models include `block`. Used to give commands read-your-writes. */
  async caughtUpTo(block: bigint, timeoutMs = 20_000): Promise<void> {
    if (this.cursor >= block) return;
    const reached = new Promise<void>((resolve) => this.waiters.push({ block, resolve }));
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`The indexer did not reach block ${block} in time`)), timeoutMs).unref(),
    );
    void this.poll();
    await Promise.race([reached, timeout]);
  }

  /** Runs one pass. Concurrent callers share the pass that is already running. */
  poll(): Promise<void> {
    this.polling ??= this.advance().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.poll()
        .catch((error) => console.error("Indexer pass failed", error))
        .finally(() => this.schedule());
    }, config.chain.pollMs);
    this.timer.unref();
  }

  private async advance(): Promise<void> {
    const head = (await publicClient.getBlockNumber()) - BigInt(config.chain.confirmations);
    while (this.cursor < head) {
      const from = this.cursor + 1n;
      const to = from + BLOCKS_PER_BATCH - 1n < head ? from + BLOCKS_PER_BATCH - 1n : head;
      await this.applyRange(from, to);
      this.cursor = to;
      this.release();
    }
  }

  private async applyRange(from: bigint, to: bigint): Promise<void> {
    const logs = await publicClient.getLogs({ address: allAddresses, fromBlock: from, toBlock: to });
    const blockTimes = await this.blockTimes([...logs.map((log) => log.blockNumber), to]);
    const events = logs
      .map((log) => this.decode(log, blockTimes))
      .filter((event): event is ChainEvent => event !== undefined);

    await transaction(async (db) => {
      for (const event of events) await this.apply(db, event);
      await db.query(
        `INSERT INTO indexer_cursor (id, block_number, block_time, updated_at)
         VALUES (1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE
           SET block_number = EXCLUDED.block_number, block_time = EXCLUDED.block_time, updated_at = now()`,
        [to, blockTimes.get(to)],
      );
    });
  }

  private async apply(db: Queryable, event: ChainEvent): Promise<void> {
    await db.query(
      `INSERT INTO chain_events (block_number, block_time, tx_hash, log_index, contract, event_name, args)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.blockNumber,
        event.blockTime,
        event.txHash,
        event.logIndex,
        event.contract,
        event.name,
        toJson(event.args),
      ],
    );
    const projection = projections[event.contract][event.name];
    if (projection) await projection(db, event as ChainEvent<never>);
  }

  private decode(log: Log, blockTimes: Map<bigint, string>): ChainEvent | undefined {
    const contract = contractNameOf(log.address);
    if (!contract || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
      return undefined;
    }
    try {
      const decoded = decodeEventLog({ abi: abis[contract] as Abi, data: log.data, topics: log.topics });
      if (!decoded.eventName) return undefined;
      return {
        contract,
        name: decoded.eventName,
        args: (decoded.args ?? {}) as unknown as Record<string, unknown>,
        blockNumber: log.blockNumber,
        blockTime: blockTimes.get(log.blockNumber) as string,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
      };
    } catch {
      // An event that is not part of the published ABI carries nothing the read models need.
      return undefined;
    }
  }

  private async blockTimes(blockNumbers: (bigint | null)[]): Promise<Map<bigint, string>> {
    const distinct = [...new Set(blockNumbers.filter((value): value is bigint => value !== null))];
    const blocks = await Promise.all(distinct.map((blockNumber) => publicClient.getBlock({ blockNumber })));
    return new Map(blocks.map((block) => [block.number, new Date(Number(block.timestamp) * 1000).toISOString()]));
  }

  private release(): void {
    const ready = this.waiters.filter((waiter) => waiter.block <= this.cursor);
    this.waiters = this.waiters.filter((waiter) => waiter.block > this.cursor);
    for (const waiter of ready) waiter.resolve();
  }
}

export const indexer = new Indexer();
