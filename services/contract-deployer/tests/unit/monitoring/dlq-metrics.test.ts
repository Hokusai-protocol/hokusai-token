const cwSend = jest.fn().mockResolvedValue({});
const putMetricCtor = jest.fn().mockImplementation((input: unknown) => ({ input }));

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: cwSend })),
  PutMetricDataCommand: putMetricCtor,
}));

import { DlqMetricsEmitter, dlqMetricNames } from '../../../src/monitoring/dlq-metrics';

beforeEach(() => {
  cwSend.mockClear();
  putMetricCtor.mockClear();
});

describe('dlqMetricNames (HOK-1698 failed-tx spikes)', () => {
  it('always emits the aggregate mint_dlq plus a per-failure-tag metric', () => {
    expect(dlqMetricNames('budget_exhausted (retries=5): MintBudgetExceeded')).toEqual([
      'mint_dlq',
      'mint_dlq_budget_exhausted',
    ]);
  });

  it('classifies a security-relevant attester failure', () => {
    expect(dlqMetricNames('exhausted (retries=3): SignerNotAttester(0xabc)')).toEqual([
      'mint_dlq',
      'mint_dlq_signer_not_attester',
    ]);
  });

  it('falls back to mint_dlq_other for an unrecognized reason', () => {
    expect(dlqMetricNames('something weird happened')).toEqual(['mint_dlq', 'mint_dlq_other']);
  });
});

describe('DlqMetricsEmitter', () => {
  const baseConfig = {
    enabled: true,
    namespace: 'Hokusai/ContractMonitoring',
    environment: 'sepolia',
  };

  it('publishes both metrics in one call with a single [Environment] dimension', async () => {
    const emitter = new DlqMetricsEmitter(baseConfig);
    await emitter.recordDeadLetter('exhausted (retries=3): SignerNotAttester(0xabc)');

    expect(cwSend).toHaveBeenCalledTimes(1);
    const input = putMetricCtor.mock.calls[0][0] as {
      Namespace: string;
      MetricData: Array<{ MetricName: string; Value: number; Dimensions: unknown[] }>;
    };
    expect(input.Namespace).toBe('Hokusai/ContractMonitoring');
    expect(input.MetricData.map((m) => m.MetricName)).toEqual([
      'mint_dlq',
      'mint_dlq_signer_not_attester',
    ]);
    expect(input.MetricData[0].Dimensions).toEqual([{ Name: 'Environment', Value: 'sepolia' }]);
    expect(input.MetricData.every((m) => m.Value === 1)).toBe(true);
  });

  it('does not construct a client or emit when disabled', async () => {
    const emitter = new DlqMetricsEmitter({ ...baseConfig, enabled: false });
    await emitter.recordDeadLetter('budget_exhausted (retries=5): x');
    expect(cwSend).not.toHaveBeenCalled();
  });

  it('swallows a CloudWatch failure (never breaks the dead-letter path)', async () => {
    cwSend.mockRejectedValueOnce(new Error('throttled'));
    const emitter = new DlqMetricsEmitter(baseConfig);
    await expect(
      emitter.recordDeadLetter('exhausted (retries=3): execution reverted'),
    ).resolves.toBeUndefined();
  });
});
