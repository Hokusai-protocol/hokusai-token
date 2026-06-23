const cwSend = jest.fn().mockResolvedValue({});
const putMetricCtor = jest.fn().mockImplementation((input: unknown) => ({ input }));

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: cwSend })),
  PutMetricDataCommand: putMetricCtor,
}));
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  SendEmailCommand: jest.fn(),
}));

import { AlertManager, AlertManagerConfig } from '../../../src/monitoring/alert-manager';
import { StateAlert } from '../../../src/monitoring/state-tracker';

const baseConfig: AlertManagerConfig = {
  enabled: true,
  emailEnabled: false, // isolate the CloudWatch path
  emailRecipients: [],
  emailFrom: 'alerts@hokus.ai',
  awsSesRegion: 'us-east-1',
  cloudWatchEnabled: true,
  metricsNamespace: 'Hokusai/ContractMonitoring',
  environment: 'sepolia',
  maxAlertsPerHour: 100,
  maxAlertsPerDay: 1000,
  deduplicationWindowMs: 0,
};

const tick = () => new Promise((r) => setImmediate(r)); // let the fire-and-forget emit run

const ingestionAlert: StateAlert = {
  type: 'stale_ingestion',
  priority: 'critical',
  poolAddress: 'monitor',
  modelId: 'monitor',
  message: 'Monitor ingestion unhealthy (rpc_error)',
};

describe('AlertManager CloudWatch metrics (HOK-1698)', () => {
  beforeEach(() => {
    cwSend.mockClear();
    putMetricCtor.mockClear();
  });

  it('emits a metric per alert with the alert type as the metric name + Environment/Priority dims', async () => {
    const am = new AlertManager(baseConfig);
    await am.sendAlert(ingestionAlert);
    await tick();

    expect(cwSend).toHaveBeenCalledTimes(1);
    const input = putMetricCtor.mock.calls[0][0] as {
      Namespace: string;
      MetricData: Array<{
        MetricName: string;
        Value: number;
        Dimensions: Array<{ Name: string; Value: string }>;
      }>;
    };
    expect(input.Namespace).toBe('Hokusai/ContractMonitoring');
    expect(input.MetricData[0].MetricName).toBe('stale_ingestion');
    expect(input.MetricData[0].Value).toBe(1);
    expect(input.MetricData[0].Dimensions).toEqual(
      expect.arrayContaining([
        { Name: 'Environment', Value: 'sepolia' },
        { Name: 'Priority', Value: 'critical' },
      ]),
    );
  });

  it('recordHeartbeat emits a Heartbeat liveness metric', async () => {
    const am = new AlertManager(baseConfig);
    await am.recordHeartbeat();
    expect(
      putMetricCtor.mock.calls.some(
        (c) =>
          (c[0] as { MetricData: Array<{ MetricName: string }> }).MetricData[0].MetricName ===
          'Heartbeat',
      ),
    ).toBe(true);
  });

  it('emits the metric even when email is throttled (ground truth before dedup)', async () => {
    const am = new AlertManager({ ...baseConfig, deduplicationWindowMs: 60_000 });
    await am.sendAlert(ingestionAlert);
    await am.sendAlert(ingestionAlert); // deduplicated for email, but each occurrence still metered
    await tick();
    expect(cwSend).toHaveBeenCalledTimes(2);
  });

  it('emits nothing when cloudWatchEnabled is false', async () => {
    const am = new AlertManager({ ...baseConfig, cloudWatchEnabled: false });
    await am.recordHeartbeat();
    await am.sendAlert(ingestionAlert);
    await tick();
    expect(cwSend).not.toHaveBeenCalled();
  });
});
