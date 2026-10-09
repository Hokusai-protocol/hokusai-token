import { ethers } from 'ethers';
import { AMMMonitor } from '../../../src/monitoring/amm-monitor';
import { PoolConfig } from '../../../src/config/monitoring-config';

const pool: PoolConfig = {
  modelId: 'model-1',
  tokenAddress: '0x0000000000000000000000000000000000000001',
  ammAddress: '0x0000000000000000000000000000000000000002',
  crr: 200_000,
  tradeFee: 30,
  protocolFee: 10,
  ibrDuration: 0,
  flatCurveThreshold: '0',
  flatCurvePrice: '0',
};

type TestMonitor = {
  config: Record<string, unknown>;
  provider: ethers.Provider;
  primaryProvider?: ethers.Provider;
  backupProvider?: ethers.Provider;
  poolDiscovery: {
    getDiscoveredPools: jest.Mock;
    getPoolCount: jest.Mock;
    stopListening: jest.Mock;
    setProvider: jest.Mock;
    startListening: jest.Mock;
  };
  stateTracker: {
    getTrackedPoolCount: jest.Mock;
    stopAllTracking: jest.Mock;
    setProvider: jest.Mock;
  };
  eventListener: {
    getListeningPoolCount: jest.Mock;
    stopAllListening: jest.Mock;
    setProvider: jest.Mock;
  };
  metricsCollector: { getAllPoolMetrics: jest.Mock };
  alertManager: { recordRpcProviderState: jest.Mock };
  startMonitoringPool: jest.Mock;
  handleAlert: jest.Mock;
  createPrimaryProbeProvider: jest.Mock;
  createMonitoringProvider: jest.Mock;
  verifyProviderCandidate: jest.Mock;
  destroyProvider: jest.Mock;
  handlePoolDiscovered(poolConfig: PoolConfig, origin: string): Promise<void>;
  rebindProvider: jest.Mock | ((provider: ethers.Provider) => Promise<void>);
  maybeFailBackToPrimary(nowMs?: number): Promise<boolean>;
  handlePrimaryRpcError(nowMs?: number): Promise<boolean>;
  switchToBackupProvider: jest.Mock | (() => Promise<void>);
  reconnectPrimary: jest.Mock | (() => Promise<boolean>);
  getHealth(): ReturnType<AMMMonitor['getHealth']>;
  isRunning: boolean;
  startTime: number;
  errors: string[];
  ingestionSampled: boolean;
  ingestionReason: string | null;
  ingestionHealth: {
    healthy: boolean;
    lastBlockNumber: number | null;
    lastAdvanceAtMs: number | null;
  };
  usingBackupProvider: boolean;
  backupActivatedAtMs: number | null;
  primaryRecoverySuccesses: number;
  consecutivePrimaryRpcErrors: number;
  backupRejectedUntilMs: number | null;
  providerRebindInFlight: boolean;
};

function createMonitor(): TestMonitor {
  const monitor = Object.create(AMMMonitor.prototype) as TestMonitor;
  monitor.config = {
    alertsEnabled: true,
    poolDiscoveryEnabled: true,
    statePollingEnabled: true,
    eventListenersEnabled: true,
    rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/test',
    chainId: 1,
    contracts: { ammFactory: '0x0000000000000000000000000000000000000003' },
    thresholds: {
      ingestionRpcTimeoutMs: 10_000,
      primaryRpcFailbackMinBackupMs: 300_000,
      primaryRpcFailbackSuccesses: 3,
      primaryRpcFailbackMaxBlockLag: 3,
      backupRpcFailoverConsecutiveErrors: 2,
      backupRpcRejectCooldownMs: 900_000,
    },
  };
  monitor.poolDiscovery = {
    getDiscoveredPools: jest.fn(() => [pool]),
    getPoolCount: jest.fn(() => 1),
    stopListening: jest.fn(),
    setProvider: jest.fn(),
    startListening: jest.fn(() => Promise.resolve()),
  };
  monitor.stateTracker = {
    getTrackedPoolCount: jest.fn(() => 1),
    stopAllTracking: jest.fn(),
    setProvider: jest.fn(),
  };
  monitor.eventListener = {
    getListeningPoolCount: jest.fn(() => 1),
    stopAllListening: jest.fn(),
    setProvider: jest.fn(),
  };
  monitor.metricsCollector = { getAllPoolMetrics: jest.fn(() => [{}]) };
  monitor.alertManager = { recordRpcProviderState: jest.fn(() => Promise.resolve()) };
  monitor.startMonitoringPool = jest.fn(() => Promise.resolve());
  monitor.handleAlert = jest.fn(() => Promise.resolve());
  monitor.createPrimaryProbeProvider = jest.fn();
  monitor.createMonitoringProvider = jest.fn();
  monitor.verifyProviderCandidate = jest.fn();
  monitor.destroyProvider = jest.fn();
  monitor.isRunning = true;
  monitor.startTime = Date.now();
  monitor.errors = [];
  monitor.ingestionSampled = true;
  monitor.ingestionReason = null;
  monitor.ingestionHealth = {
    healthy: true,
    lastBlockNumber: 100,
    lastAdvanceAtMs: Date.now(),
  };
  monitor.usingBackupProvider = false;
  monitor.backupActivatedAtMs = null;
  monitor.primaryRecoverySuccesses = 0;
  monitor.consecutivePrimaryRpcErrors = 0;
  monitor.backupRejectedUntilMs = null;
  monitor.providerRebindInFlight = false;
  return monitor;
}

describe('AMMMonitor resilience wiring', () => {
  it('monitors bootstrap pools without sending a new-pool alert', async () => {
    const monitor = createMonitor();

    await monitor.handlePoolDiscovered(pool, 'bootstrap');

    expect(monitor.startMonitoringPool).toHaveBeenCalledWith(pool.ammAddress, pool);
    expect(monitor.handleAlert).not.toHaveBeenCalled();
  });

  it('sends a new-pool alert only for live discovery', async () => {
    const monitor = createMonitor();

    await monitor.handlePoolDiscovered(pool, 'live');

    expect(monitor.handleAlert).toHaveBeenCalledTimes(1);
  });

  it('rebinds every provider-bound component and resumes all pools', async () => {
    const monitor = createMonitor();
    const provider = {} as ethers.Provider;

    await monitor.rebindProvider(provider);

    expect(monitor.poolDiscovery.setProvider).toHaveBeenCalledWith(provider);
    expect(monitor.stateTracker.setProvider).toHaveBeenCalledWith(provider);
    expect(monitor.eventListener.setProvider).toHaveBeenCalledWith(provider);
    expect(monitor.startMonitoringPool).toHaveBeenCalledWith(pool.ammAddress, pool);
    expect(monitor.poolDiscovery.startListening).toHaveBeenCalledWith('latest');
  });

  it('reports unhealthy when the actual ingestion heartbeat is unhealthy', () => {
    const monitor = createMonitor();
    monitor.ingestionHealth.healthy = false;
    monitor.ingestionReason = 'rpc_error';

    const health = monitor.getHealth();

    expect(health.status).toBe('unhealthy');
    expect(health.isHealthy).toBe(false);
    expect(health.ingestion).toMatchObject({
      healthy: false,
      sampled: true,
      reason: 'rpc_error',
    });
  });

  it('returns from backup to a fresh primary only after stable probes and the dwell', async () => {
    const monitor = createMonitor();
    const backupProvider = { name: 'backup' } as unknown as ethers.Provider;
    const primaryProvider = { name: 'primary' } as unknown as ethers.Provider;
    monitor.provider = backupProvider;
    monitor.backupProvider = backupProvider;
    monitor.usingBackupProvider = true;
    monitor.backupActivatedAtMs = 1_000;
    monitor.createPrimaryProbeProvider.mockImplementation(() => ({}));
    monitor.createMonitoringProvider.mockReturnValue(primaryProvider);
    monitor.verifyProviderCandidate.mockResolvedValue(1_000);
    monitor.rebindProvider = jest.fn((provider: ethers.Provider) => {
      monitor.provider = provider;
      return Promise.resolve();
    });

    await expect(monitor.maybeFailBackToPrimary(301_000)).resolves.toBe(false);
    await expect(monitor.maybeFailBackToPrimary(301_000)).resolves.toBe(false);
    await expect(monitor.maybeFailBackToPrimary(301_000)).resolves.toBe(true);

    expect(monitor.rebindProvider).toHaveBeenCalledWith(primaryProvider);
    expect(monitor.provider).toBe(primaryProvider);
    expect(monitor.primaryProvider).toBe(primaryProvider);
    expect(monitor.usingBackupProvider).toBe(false);
    expect(monitor.backupActivatedAtMs).toBeNull();
    expect(monitor.primaryRecoverySuccesses).toBe(0);
    expect(monitor.alertManager.recordRpcProviderState).toHaveBeenCalledWith(false);
    expect(monitor.handleAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rpc_primary_recovered' }),
    );
  });

  it('does not leave the backup before the anti-flap dwell', async () => {
    const monitor = createMonitor();
    monitor.provider = { name: 'backup' } as unknown as ethers.Provider;
    monitor.usingBackupProvider = true;
    monitor.backupActivatedAtMs = 1_000;
    (monitor.config.thresholds as Record<string, number>).primaryRpcFailbackSuccesses = 1;
    monitor.createPrimaryProbeProvider.mockImplementation(() => ({}));
    monitor.verifyProviderCandidate.mockResolvedValue(1_000);
    monitor.rebindProvider = jest.fn(() => Promise.resolve());

    await expect(monitor.maybeFailBackToPrimary(300_999)).resolves.toBe(false);

    expect(monitor.rebindProvider).not.toHaveBeenCalled();
    expect(monitor.usingBackupProvider).toBe(true);
  });

  it('rejects a primary recovery probe that is behind the active chain head', async () => {
    const monitor = createMonitor();
    monitor.ingestionHealth.lastBlockNumber = 1_000;
    monitor.provider = { name: 'backup' } as unknown as ethers.Provider;
    monitor.usingBackupProvider = true;
    monitor.backupActivatedAtMs = 1_000;
    (monitor.config.thresholds as Record<string, number>).primaryRpcFailbackSuccesses = 1;
    const provider = {
      getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n })),
      getBlockNumber: jest.fn(() => Promise.resolve(990)),
    } as unknown as ethers.Provider;
    monitor.createPrimaryProbeProvider.mockReturnValue(provider);
    delete (monitor as { verifyProviderCandidate?: jest.Mock }).verifyProviderCandidate;

    await expect(monitor.maybeFailBackToPrimary(301_000)).resolves.toBe(false);

    expect(monitor.primaryRecoverySuccesses).toBe(0);
    expect(monitor.createMonitoringProvider).not.toHaveBeenCalled();
    expect(monitor.usingBackupProvider).toBe(true);
  });

  it('resets primary recovery confidence after a failed probe', async () => {
    const monitor = createMonitor();
    monitor.provider = { name: 'backup' } as unknown as ethers.Provider;
    monitor.usingBackupProvider = true;
    monitor.backupActivatedAtMs = 1_000;
    monitor.primaryRecoverySuccesses = 2;
    monitor.createPrimaryProbeProvider.mockImplementation(() => ({}));
    monitor.verifyProviderCandidate.mockRejectedValue(new Error('primary unavailable'));
    monitor.rebindProvider = jest.fn(() => Promise.resolve());

    await expect(monitor.maybeFailBackToPrimary(301_000)).resolves.toBe(false);

    expect(monitor.primaryRecoverySuccesses).toBe(0);
    expect(monitor.rebindProvider).not.toHaveBeenCalled();
    expect(monitor.usingBackupProvider).toBe(true);
  });

  it('restores the backup if rebuilding listeners on the primary fails', async () => {
    const monitor = createMonitor();
    const backupProvider = { name: 'backup' } as unknown as ethers.Provider;
    const primaryProvider = { name: 'primary' } as unknown as ethers.Provider;
    monitor.provider = backupProvider;
    monitor.backupProvider = backupProvider;
    monitor.usingBackupProvider = true;
    monitor.backupActivatedAtMs = 1_000;
    (monitor.config.thresholds as Record<string, number>).primaryRpcFailbackSuccesses = 1;
    monitor.createPrimaryProbeProvider.mockImplementation(() => ({}));
    monitor.createMonitoringProvider.mockReturnValue(primaryProvider);
    monitor.verifyProviderCandidate.mockResolvedValue(1_000);
    monitor.rebindProvider = jest
      .fn()
      .mockImplementationOnce((provider: ethers.Provider) => {
        monitor.provider = provider;
        return Promise.reject(new Error('filter creation failed'));
      })
      .mockImplementationOnce((provider: ethers.Provider) => {
        monitor.provider = provider;
        return Promise.resolve();
      });

    await expect(monitor.maybeFailBackToPrimary(301_000)).resolves.toBe(false);

    expect(monitor.rebindProvider).toHaveBeenNthCalledWith(1, primaryProvider);
    expect(monitor.rebindProvider).toHaveBeenNthCalledWith(2, backupProvider);
    expect(monitor.provider).toBe(backupProvider);
    expect(monitor.usingBackupProvider).toBe(true);
    expect(monitor.destroyProvider).toHaveBeenCalledWith(primaryProvider);
  });

  describe('primary RPC errors', () => {
    it('reconnects to the primary instead of using the backup on a first error', async () => {
      const monitor = createMonitor();
      monitor.backupProvider = { name: 'backup' } as unknown as ethers.Provider;
      monitor.consecutivePrimaryRpcErrors = 1;
      monitor.switchToBackupProvider = jest.fn(() => Promise.resolve());
      monitor.reconnectPrimary = jest.fn(() => Promise.resolve(true));

      await expect(monitor.handlePrimaryRpcError(0)).resolves.toBe(true);

      expect(monitor.switchToBackupProvider).not.toHaveBeenCalled();
      expect(monitor.reconnectPrimary).toHaveBeenCalledTimes(1);
    });

    it('moves to the backup after consecutive heartbeat failures', async () => {
      const monitor = createMonitor();
      monitor.backupProvider = { name: 'backup' } as unknown as ethers.Provider;
      monitor.consecutivePrimaryRpcErrors = 2;
      monitor.switchToBackupProvider = jest.fn(() => Promise.resolve());
      monitor.reconnectPrimary = jest.fn(() => Promise.resolve(true));

      await expect(monitor.handlePrimaryRpcError(0)).resolves.toBe(true);

      expect(monitor.switchToBackupProvider).toHaveBeenCalledTimes(1);
      expect(monitor.reconnectPrimary).not.toHaveBeenCalled();
    });

    it('stays on the primary and cools down when the backup is rejected', async () => {
      const monitor = createMonitor();
      monitor.backupProvider = { name: 'backup' } as unknown as ethers.Provider;
      monitor.consecutivePrimaryRpcErrors = 2;
      monitor.switchToBackupProvider = jest.fn(() =>
        Promise.reject(new Error('Too Many Requests')),
      );
      monitor.reconnectPrimary = jest.fn(() => Promise.resolve(false));

      await expect(monitor.handlePrimaryRpcError(1_000)).resolves.toBe(false);

      expect(monitor.backupRejectedUntilMs).toBe(901_000);
      expect(monitor.reconnectPrimary).toHaveBeenCalledTimes(1);

      monitor.consecutivePrimaryRpcErrors = 3;
      await monitor.handlePrimaryRpcError(900_999);
      expect(monitor.switchToBackupProvider).toHaveBeenCalledTimes(1);

      await monitor.handlePrimaryRpcError(901_000);
      expect(monitor.switchToBackupProvider).toHaveBeenCalledTimes(2);
    });

    it('refuses a backup that throttles a burst of calls', async () => {
      const monitor = createMonitor();
      const throttled = Object.assign(new Error('Too Many Requests'), { code: -32005 });
      const getCode = jest.fn(() => Promise.reject(throttled));
      const backupProvider = {
        getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n, name: 'mainnet' })),
        getBlockNumber: jest.fn(() => Promise.resolve(1_000)),
        getCode,
      } as unknown as ethers.Provider;
      monitor.backupProvider = backupProvider;
      monitor.rebindProvider = jest.fn(() => Promise.resolve());

      await expect(monitor.switchToBackupProvider()).rejects.toThrow('Too Many Requests');

      expect(getCode).toHaveBeenCalledWith(pool.ammAddress);
      expect(monitor.rebindProvider).not.toHaveBeenCalled();
      expect(monitor.usingBackupProvider).toBe(false);
      expect(monitor.providerRebindInFlight).toBe(false);
    });

    it('rebinds every component to a fresh primary when it answers', async () => {
      const monitor = createMonitor();
      const stalePrimary = { name: 'stale' } as unknown as ethers.Provider;
      const freshPrimary = { name: 'fresh' } as unknown as ethers.Provider;
      monitor.provider = stalePrimary;
      monitor.primaryProvider = stalePrimary;
      monitor.createMonitoringProvider.mockReturnValue(freshPrimary);
      monitor.verifyProviderCandidate.mockResolvedValue(1_000);
      monitor.rebindProvider = jest.fn((provider: ethers.Provider) => {
        monitor.provider = provider;
        return Promise.resolve();
      });

      await expect(monitor.reconnectPrimary()).resolves.toBe(true);

      expect(monitor.rebindProvider).toHaveBeenCalledWith(freshPrimary);
      expect(monitor.primaryProvider).toBe(freshPrimary);
      expect(monitor.destroyProvider).toHaveBeenCalledWith(stalePrimary);
      expect(monitor.providerRebindInFlight).toBe(false);
    });

    it('keeps the current provider when the primary still does not answer', async () => {
      const monitor = createMonitor();
      const stalePrimary = { name: 'stale' } as unknown as ethers.Provider;
      const candidate = { name: 'candidate' } as unknown as ethers.Provider;
      monitor.provider = stalePrimary;
      monitor.createMonitoringProvider.mockReturnValue(candidate);
      monitor.verifyProviderCandidate.mockRejectedValue(new Error('primary unavailable'));
      monitor.rebindProvider = jest.fn(() => Promise.resolve());

      await expect(monitor.reconnectPrimary()).resolves.toBe(false);

      expect(monitor.rebindProvider).not.toHaveBeenCalled();
      expect(monitor.provider).toBe(stalePrimary);
      expect(monitor.destroyProvider).toHaveBeenCalledWith(candidate);
    });
  });
});
