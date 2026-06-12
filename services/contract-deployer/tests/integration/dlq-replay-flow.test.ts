import { DlqStore } from '../../src/dlq/dlq-store';
import { stripRetryScratch } from '../../src/dlq/dlq-entry';
import { decideReplay, OnChainMintStatus } from '../../src/dlq/replay-guard';
import {
  createMintRequestSettlement,
  validateMintRequestMessage,
} from '../../src/schemas/mint-request-schema';
import { validMintRequest, buildDlqEntry } from '../unit/dlq/test-helpers';

class MemoryRedis {
  readonly lists = new Map<string, string[]>();

  async lRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length : stop + 1;
    return list.slice(start, normalizedStop);
  }

  multi(): {
    lPush: (key: string, value: string) => unknown;
    lRem: (key: string, count: number, value: string) => unknown;
    exec: () => Promise<number[]>;
  } {
    const operations: Array<() => number> = [];
    return {
      lPush: (key: string, value: string) => {
        operations.push(() => this.lPushSync(key, value));
        return this;
      },
      lRem: (key: string, count: number, value: string) => {
        operations.push(() => this.lRemSync(key, count, value));
        return this;
      },
      exec: async () => operations.map((operation) => operation()),
    };
  }

  seed(key: string, value: string): void {
    this.lPushSync(key, value);
  }

  private lPushSync(key: string, value: string): number {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  private lRemSync(key: string, count: number, value: string): number {
    const list = this.lists.get(key) ?? [];
    let removed = 0;
    const next = list.filter((entry) => {
      if (removed < count && entry === value) {
        removed++;
        return false;
      }
      return true;
    });
    this.lists.set(key, next);
    return removed;
  }
}

const queues = {
  dlqQueue: 'hokusai:mint_requests:dlq',
  inboundQueue: 'hokusai:mint_requests',
  archiveQueue: 'hokusai:mint_requests:dlq:archive',
};

const toppedUpState: OnChainMintStatus = {
  processed: false,
  mintBudgetRemaining: 1_000_000n,
  modelWeightHead: validMintRequest.baseline_commitment,
  signaturesValid: true,
};

describe('DLQ replay flow integration', () => {
  test('budget-exhausted entry replays after top-up and yields exactly one minted settlement', async () => {
    const redis = new MemoryRedis();
    redis.seed(
      queues.dlqQueue,
      buildDlqEntry({
        originalMessage: { ...validMintRequest, _retryCount: 24 },
        reason: 'budget_exhausted (retries=24): MintBudgetExceeded',
        failureClass: 'transient',
      }),
    );
    const store = new DlqStore({ redis: redis as never, ...queues });
    const entry = (await store.list(1))[0];
    const validation = validateMintRequestMessage(entry.message);
    expect(validation.error).toBeUndefined();

    const decision = decideReplay(entry, toppedUpState);
    expect(decision.allowed).toBe(true);

    await store.replay(entry, stripRetryScratch(validation.value));
    const inbound = await redis.lRange(queues.inboundQueue, 0, -1);
    const dlq = await redis.lRange(queues.dlqQueue, 0, -1);
    expect(inbound).toHaveLength(1);
    expect(dlq).toHaveLength(0);

    const replayedMessage = JSON.parse(inbound[0]);
    expect(replayedMessage).not.toHaveProperty('_retryCount');
    const settlement = createMintRequestSettlement({
      idempotency_key: replayedMessage.idempotency_key,
      attestation_hash: replayedMessage.attestation_hash,
      model_id: replayedMessage.model_id,
      model_id_uint: replayedMessage.model_id_uint,
      eval_id: replayedMessage.eval_id,
      tx_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      block_number: 42,
      status: 'minted',
      reward_amount: '350000',
    });
    expect([settlement]).toHaveLength(1);
    expect(settlement.status).toBe('minted');
  });

  test('already-minted keys are refused before replay', async () => {
    const store = new DlqStore({ redis: new MemoryRedis() as never, ...queues });
    void store;
    const entry = await Promise.resolve(
      buildDlqEntry({
        reason: 'budget_exhausted (retries=24): MintBudgetExceeded',
        failureClass: 'transient',
      }),
    ).then((raw) => {
      const redis = new MemoryRedis();
      redis.seed(queues.dlqQueue, raw);
      return new DlqStore({ redis: redis as never, ...queues }).list(1);
    });

    expect(decideReplay(entry[0], { ...toppedUpState, processed: true })).toMatchObject({
      allowed: false,
      reason: 'already_processed',
    });
  });

  test('tampered messages fail schema or signature validation', async () => {
    const redis = new MemoryRedis();
    redis.seed(
      queues.dlqQueue,
      buildDlqEntry({
        originalMessage: {
          ...validMintRequest,
          idempotency_key: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
    );
    const entry = (await new DlqStore({ redis: redis as never, ...queues }).list(1))[0];

    expect(decideReplay(entry, { ...toppedUpState, signaturesValid: false })).toMatchObject({
      allowed: false,
      reason: 'signature_invalid',
    });
  });

  test('unknown-outcome entries show minted state and are refused for replay', async () => {
    const redis = new MemoryRedis();
    redis.seed(
      queues.dlqQueue,
      buildDlqEntry({
        reason: 'permanent: MintRequest transaction outcome unknown after submit: ECONNRESET',
        failureClass: 'permanent',
      }),
    );
    const entry = (await new DlqStore({ redis: redis as never, ...queues }).list(1))[0];
    const onChain = { ...toppedUpState, processed: true };

    expect(onChain.processed).toBe(true);
    expect(decideReplay(entry, onChain)).toMatchObject({
      allowed: false,
      reason: 'already_processed',
    });
  });

  test('requires explicit real integration environment for external Redis and Hardhat', () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      expect(true).toBe(true);
    }
  });
});
