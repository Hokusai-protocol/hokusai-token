import { RedisClientType } from 'redis';
import { MintRequestSettlement } from '../schemas/mint-request-schema';
import { parseTrusted } from '../utils/json';

export interface MintRecordStoreConfig {
  redis: RedisClientType;
  keyPrefix: string;
  ttlSeconds: number;
}

export interface MintRecord {
  idempotency_key: string;
  model_id: string;
  tx_hash?: string;
  status: MintRequestSettlement['status'];
  failure_class?: 'transient' | 'permanent';
  reward_amount: string;
  block_number?: number;
  gas_used?: string;
  error?: string;
  updated_at: string;
}

export class MintRecordStore {
  constructor(private readonly config: MintRecordStoreConfig) {}

  // Standalone convenience for tests. Production writes use getKey/serializeSettled/getTtlSeconds
  // inside a Redis MULTI to atomically record with processedSet membership.
  async recordSettled(settlement: MintRequestSettlement): Promise<void> {
    const record = this.serializeSettled(settlement);
    await this.config.redis.set(this.getKey(settlement.idempotency_key), JSON.stringify(record), {
      EX: this.config.ttlSeconds,
    });
  }

  async recordError(
    idempotencyKey: string,
    modelId: string,
    reason: string,
    options?: {
      status?: MintRequestSettlement['status'];
      failureClass?: 'transient' | 'permanent';
    },
  ): Promise<void> {
    const record: MintRecord = {
      idempotency_key: idempotencyKey,
      model_id: modelId,
      status: options?.status ?? 'error',
      failure_class: options?.failureClass,
      reward_amount: '0',
      error: reason,
      updated_at: new Date().toISOString(),
    };

    await this.config.redis.set(this.getKey(idempotencyKey), JSON.stringify(record), {
      EX: this.config.ttlSeconds,
    });
  }

  async get(idempotencyKey: string): Promise<MintRecord | null> {
    const value = await this.config.redis.get(this.getKey(idempotencyKey));
    if (value === null) {
      return null;
    }

    return parseTrusted<MintRecord>(value);
  }

  getKey(idempotencyKey: string): string {
    return `${this.config.keyPrefix}${idempotencyKey}`;
  }

  getTtlSeconds(): number {
    return this.config.ttlSeconds;
  }

  serializeRetrying(
    idempotencyKey: string,
    modelId: string,
    reason: string,
    failureClass: 'transient' | 'permanent',
    status: MintRequestSettlement['status'] = 'error',
  ): MintRecord {
    return {
      idempotency_key: idempotencyKey,
      model_id: modelId,
      status,
      failure_class: failureClass,
      reward_amount: '0',
      error: reason,
      updated_at: new Date().toISOString(),
    };
  }

  serializeSettled(settlement: MintRequestSettlement): MintRecord {
    return {
      idempotency_key: settlement.idempotency_key,
      model_id: settlement.model_id,
      tx_hash: settlement.tx_hash,
      status: settlement.status,
      failure_class: settlement.status === 'error' ? 'permanent' : undefined,
      reward_amount: settlement.reward_amount,
      block_number: settlement.block_number,
      gas_used: settlement.gas_used,
      error: settlement.error,
      updated_at: settlement.settled_at,
    };
  }
}
