import { classifyError, computeBackoffMs } from '../../../src/queue/retry-policy';

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

  test('defaults unknown failures to transient', () => {
    expect(classifyError(new Error('unexpected failure'))).toBe('transient');
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
