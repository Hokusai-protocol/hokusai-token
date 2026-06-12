import { RedisClientType } from 'redis';
import { parseDlqEntry, ParsedDlqEntry } from './dlq-entry';
import { MintRequestMessage } from '../schemas/mint-request-schema';

export interface DlqStoreConfig {
  redis: RedisClientType;
  dlqQueue: string;
  inboundQueue: string;
  archiveQueue: string;
}

export interface DlqArchiveEnvelope {
  archivedAt: string;
  operator: string;
  reason: string;
  originalDlqEntry: string;
}

export interface DlqReplayResult {
  inboundDepth: number;
  removedCount: number;
}

export interface DlqDiscardResult {
  archiveDepth: number;
  removedCount: number;
}

export class DlqEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`No DLQ entry found with id ${id}`);
    this.name = 'DlqEntryNotFoundError';
  }
}

export class DlqEntryAmbiguousError extends Error {
  readonly matches: string[];

  constructor(idPrefix: string, matches: string[]) {
    super(`DLQ id prefix ${idPrefix} is ambiguous: ${matches.join(', ')}`);
    this.name = 'DlqEntryAmbiguousError';
    this.matches = matches;
  }
}

export class DlqStore {
  private readonly redis: RedisClientType;
  private readonly dlqQueue: string;
  private readonly inboundQueue: string;
  private readonly archiveQueue: string;

  constructor(config: DlqStoreConfig) {
    this.redis = config.redis;
    this.dlqQueue = config.dlqQueue;
    this.inboundQueue = config.inboundQueue;
    this.archiveQueue = config.archiveQueue;
  }

  async list(limit: number): Promise<ParsedDlqEntry[]> {
    const end = Math.max(0, limit) - 1;
    if (end < 0) {
      return [];
    }

    const rawEntries = await this.redis.lRange(this.dlqQueue, 0, end);
    return rawEntries.map((rawEntry) => parseDlqEntry(rawEntry));
  }

  async getById(idPrefix: string): Promise<ParsedDlqEntry> {
    const rawEntries = await this.redis.lRange(this.dlqQueue, 0, -1);
    const matches = rawEntries
      .map((rawEntry) => parseDlqEntry(rawEntry))
      .filter((entry) => entry.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new DlqEntryNotFoundError(idPrefix);
    }

    if (matches.length > 1) {
      throw new DlqEntryAmbiguousError(
        idPrefix,
        matches.map((entry) => entry.id),
      );
    }

    const match = matches[0];
    if (match === undefined) {
      throw new DlqEntryNotFoundError(idPrefix);
    }

    return match;
  }

  async replay(entry: ParsedDlqEntry, message: MintRequestMessage): Promise<DlqReplayResult> {
    const multi = this.redis.multi();
    multi.lPush(this.inboundQueue, JSON.stringify(message));
    multi.lRem(this.dlqQueue, 1, entry.raw);
    const results = (await multi.exec()) as unknown[];

    return {
      inboundDepth: numericTransactionResult(results[0]),
      removedCount: numericTransactionResult(results[1]),
    };
  }

  async discard(
    entry: ParsedDlqEntry,
    reason: string,
    operator: string,
  ): Promise<DlqDiscardResult> {
    const envelope: DlqArchiveEnvelope = {
      archivedAt: new Date().toISOString(),
      operator,
      reason,
      originalDlqEntry: entry.raw,
    };
    const multi = this.redis.multi();
    multi.lPush(this.archiveQueue, JSON.stringify(envelope));
    multi.lRem(this.dlqQueue, 1, entry.raw);
    const results = (await multi.exec()) as unknown[];

    return {
      archiveDepth: numericTransactionResult(results[0]),
      removedCount: numericTransactionResult(results[1]),
    };
  }
}

function numericTransactionResult(result: unknown): number {
  if (typeof result === 'number') {
    return result;
  }

  if (Array.isArray(result) && typeof result[1] === 'number') {
    return result[1];
  }

  return 0;
}
