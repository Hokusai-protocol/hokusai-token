import { RedisClientType } from 'redis';
import { MintRequestSettlement } from '../schemas/mint-request-schema';

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
  reward_amount: string;
  block_number?: number;
  gas_used?: string;
  error?: string;
  updated_at: string;
}

export class MintRecordStore {
  constructor(private readonly config: MintRecordStoreConfig) {}

  async recordSettled(settlement: MintRequestSettlement): Promise<void> {
    const record = this.serializeSettled(settlement);
    await this.config.redis.set(this.getKey(settlement.idempotency_key), JSON.stringify(record), {
      EX: this.config.ttlSeconds,
    });
  }

  async recordError(idempotencyKey: string, modelId: string, reason: string): Promise<void> {
    const record: MintRecord = {
      idempotency_key: idempotencyKey,
      model_id: modelId,
      status: 'error',
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

    return JSON.parse(value) as MintRecord;
  }

  getKey(idempotencyKey: string): string {
    return `${this.config.keyPrefix}${idempotencyKey}`;
  }

  getTtlSeconds(): number {
    return this.config.ttlSeconds;
  }

  serializeSettled(settlement: MintRequestSettlement): MintRecord {
    return {
      idempotency_key: settlement.idempotency_key,
      model_id: settlement.model_id,
      tx_hash: settlement.tx_hash,
      status: settlement.status,
      reward_amount: settlement.reward_amount,
      block_number: settlement.block_number,
      gas_used: settlement.gas_used,
      error: settlement.error,
      updated_at: settlement.settled_at,
    };
  }
}
