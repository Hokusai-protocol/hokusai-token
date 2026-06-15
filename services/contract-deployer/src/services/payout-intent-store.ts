import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

/**
 * Records the payout the pipeline authorized for a mint, keyed by idempotency key,
 * so the DeltaOne anomaly detector can reconcile on-chain recipients against intent
 * (HOK-2223). Written BEFORE the mint is submitted on-chain.
 *
 * Only protocol-relevant facts are stored (recipients + model). A mint that bypasses
 * this writer leaves no record, which the detector treats as an unauthorized mint.
 */
export interface PayoutIntentStoreConfig {
  client: DynamoDBClient;
  tableName: string;
  // Records only need to outlive settlement + detection; default 30 days.
  ttlSeconds?: number;
  // Injectable clock for tests (epoch milliseconds).
  now?: () => number;
}

export interface PayoutIntent {
  idempotencyKey: string;
  recipients: string[];
  modelId: string;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export class PayoutIntentStore {
  constructor(private readonly config: PayoutIntentStoreConfig) {}

  async putIntent(intent: PayoutIntent): Promise<void> {
    const recipients = [...new Set(intent.recipients.map((address) => address.toLowerCase()))];
    if (recipients.length === 0) {
      // A mint always has at least one contributor; refuse to write an empty set
      // (DynamoDB string sets cannot be empty, and an empty intent is meaningless).
      throw new Error(
        `Refusing to write payout intent with no recipients for ${intent.idempotencyKey}`,
      );
    }

    const nowSeconds = Math.floor((this.config.now?.() ?? Date.now()) / 1000);
    const ttlSeconds = this.config.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    await this.config.client.send(
      new PutItemCommand({
        TableName: this.config.tableName,
        Item: {
          idempotency_key: { S: intent.idempotencyKey },
          recipients: { SS: recipients },
          model_id: { S: intent.modelId },
          written_at: { N: String(nowSeconds) },
          expires_at: { N: String(nowSeconds + ttlSeconds) },
        },
      }),
    );
  }
}
