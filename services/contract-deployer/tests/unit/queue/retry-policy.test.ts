import { classifyError, computeBackoffMs } from '../../../src/queue/retry-policy';
import { MintBudgetExceededError } from '../../../src/blockchain/delta-verifier-client';

describe('retry-policy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('classifies deterministic contract failures as permanent', () => {
    const error = Object.assign(new Error('Model not registered'), { code: 'CALL_EXCEPTION' });
    expect(classifyError(error)).toBe('permanent');
  });

  test('classifies network failures as transient', () => {
    const error = Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' });
    expect(classifyError(error)).toBe('transient');
  });

  test('classifies ambiguous post-submit outcomes as permanent to force DLQ review', () => {
    const error = Object.assign(new Error('receipt wait lost'), {
      failureClass: 'permanent',
      onChainOutcomeUnknown: true,
    });
    expect(classifyError(error)).toBe('permanent');
  });

  test('defaults unknown failures to transient', () => {
    expect(classifyError(new Error('unexpected failure'))).toBe('transient');
  });

  test('classifies MintBudgetExceededError as transient', () => {
    expect(
      classifyError(
        new MintBudgetExceededError('MintBudgetExceeded', {
          modelId: 21n,
          requiredAmount: 100n,
          remainingBudget: 50n,
        }),
      ),
    ).toBe('transient');
  });

  test('classifies MintBudgetExceeded message fallback as transient', () => {
    expect(classifyError(new Error('execution reverted: MintBudgetExceeded(21,100,50)'))).toBe(
      'transient',
    );
  });

  test('computes bounded backoff with jitter', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(
      computeBackoffMs(1, {
        baseMs: 1000,
        maxMs: 60000,
        multiplier: 2,
      }),
    ).toBe(500);
    expect(
      computeBackoffMs(3, {
        baseMs: 1000,
        maxMs: 3000,
        multiplier: 2,
      }),
    ).toBe(1500);
  });
});
