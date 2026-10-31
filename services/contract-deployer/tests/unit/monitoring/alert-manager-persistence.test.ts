/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement Redis and RPC interfaces. */
const send = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: jest.fn().mockImplementation(() => ({ send })),
  SendEmailCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
import { AlertManager, AlertManagerConfig } from '../../../src/monitoring/alert-manager';
import { IncidentStore, MonitoringRedis } from '../../../src/monitoring/incident-store';
import { EventAlert } from '../../../src/monitoring/event-listener';

const config: AlertManagerConfig = {
  enabled: true,
  emailEnabled: true,
  emailRecipients: ['test@example.com'],
  emailFrom: 'test@example.com',
  awsSesRegion: 'us-east-1',
  cloudWatchEnabled: false,
  metricsNamespace: 'test',
  environment: 'development',
  network: 'mainnet',
  chainId: 1,
  deployment: 'factory',
  maxAlertsPerHour: 1,
  maxAlertsPerDay: 1,
  deduplicationWindowMs: 300000,
};
const alert: EventAlert = {
  type: 'security_event',
  priority: 'critical',
  message: 'Paused',
  event: {
    type: 'paused',
    contractAddress: 'pool',
    actor: 'actor',
    details: { paused: true },
    blockNumber: 12,
    transactionHash: '0xtx',
    logIndex: 2,
    timestamp: 123,
  },
};
function redisFixture(): MonitoringRedis {
  const data = new Map<string, { value: string; expires: number }>();
  return {
    get: async (key) => {
      const v = data.get(key);
      return v && v.expires > Date.now() ? v.value : null;
    },
    set: async (key, value, options) => {
      const v = data.get(key);
      if (options?.NX && v && v.expires > Date.now()) {
        return null;
      }
      data.set(key, { value, expires: Date.now() + (options?.PX ?? 1e9) });
      return 'OK';
    },
    del: async (key) => {
      data.delete(key);
      return 1;
    },
  };
}

describe('notification persistence and scope', () => {
  beforeEach(() => send.mockResolvedValue({}));
  it('deduplicates a replay across process instances while allowing a different log in the same tx', async () => {
    const redis = redisFixture();
    const first = new AlertManager(config, new IncidentStore('1:factory', redis));
    expect(await first.sendAlert(alert)).toBe(true);
    const restarted = new AlertManager(config, new IncidentStore('1:factory', redis));
    expect(await restarted.sendAlert(alert)).toBe(false);
    expect(await restarted.sendAlert({ ...alert, event: { ...alert.event, logIndex: 3 } })).toBe(
      true,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('separates networks and deployments', async () => {
    const redis = redisFixture();
    await new AlertManager(config, new IncidentStore('1:factory', redis)).sendAlert(alert);
    await new AlertManager(config, new IncidentStore('11155111:factory', redis)).sendAlert(alert);
    await new AlertManager(config, new IncidentStore('1:new-factory', redis)).sendAlert(alert);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('releases claims after a delivery failure so the alert can be retried', async () => {
    const manager = new AlertManager(config, new IncidentStore('1:factory', redisFixture()));
    send.mockRejectedValueOnce(new Error('SES unavailable'));
    await expect(manager.sendAlert(alert)).rejects.toThrow('SES unavailable');
    expect(await manager.sendAlert(alert)).toBe(true);
  });
  it('labels recovery as informational and includes network/deployment in email', async () => {
    const manager = new AlertManager(config);
    await manager.sendAlert({
      ...alert,
      priority: 'info',
      event: { ...alert.event, type: 'unpaused' } as any,
    });
    const command = send.mock.calls[0][0];
    expect(command.input.Message.Subject.Data).toContain('INFO');
    expect(command.input.Message.Subject.Data).toContain('mainnet / chain 1 / factory');
    expect(command.input.Message.Body.Html.Data).toContain('Deployment: factory');
  });
});
