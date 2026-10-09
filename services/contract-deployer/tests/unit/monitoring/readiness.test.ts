import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import type { RedisClientType } from 'redis';
import type { AMMMonitorHealth } from '../../../src/monitoring/amm-monitor';
import { createMonitorReadinessHandler, getReadiness } from '../../../src/monitoring/readiness';
import { getBackendSigner } from '../../../src/blockchain/signer-singleton';

jest.mock('../../../src/blockchain/signer-singleton', () => ({
  getBackendSigner: jest.fn(),
}));

describe('ECS monitor readiness', () => {
  const getBlockNumber = jest.fn();
  const ping = jest.fn();
  const getHealth = jest.fn();
  const context = {
    ammMonitor: { getHealth },
    provider: { getBlockNumber } as unknown as ethers.JsonRpcProvider,
    networkChainId: 11155111n,
    redis: {
      isOpen: true,
      isReady: true,
      ping,
      lLen: jest.fn().mockResolvedValue(0),
    } as unknown as RedisClientType,
  };
  let health: AMMMonitorHealth;
  let app: express.Express;

  beforeEach(() => {
    health = {
      status: 'healthy',
      isHealthy: true,
      uptime: 100,
      poolsMonitored: 2,
      components: {
        poolDiscovery: true,
        stateTracking: true,
        eventListening: true,
        metricsCollection: true,
      },
      componentsStatus: {
        poolDiscovery: true,
        stateTracking: true,
        eventListening: true,
        metricsCollection: true,
      },
      lastUpdateTime: Date.now(),
      ingestion: {
        healthy: true,
        sampled: true,
        reason: null,
        lastBlockNumber: 100,
        lastAdvanceAtMs: Date.now(),
        usingBackupProvider: true,
      },
    };
    getHealth.mockImplementation(() => health);
    getBlockNumber.mockReset().mockRejectedValue(new Error('Alchemy unavailable'));
    ping.mockReset().mockResolvedValue('PONG');
    app = express();
    app.get('/health/monitor-ready', createMonitorReadinessHandler(context));
  });

  it('returns HTTP 200 for healthy backup ingestion while the primary is down', async () => {
    const response = await request(app).get('/health/monitor-ready').expect(200);

    expect(response.body).toMatchObject({
      ready: true,
      status: 'ready',
      checks: {
        rpc: { ok: false, gating: false, error: 'Alchemy unavailable' },
        redis: { ok: true },
        monitoring: {
          ok: true,
          ingestion: { healthy: true, usingBackupProvider: true },
        },
      },
    });
    expect(response.body.checks).not.toHaveProperty('signer');
    expect(response.body.checks).not.toHaveProperty('deltaVerifier');
    expect(getBackendSigner).not.toHaveBeenCalled();
  });

  it.each(['rpc_error', 'stale_block', 'stuck', 'not_sampled'])(
    'returns HTTP 503 for genuine ingestion failure: %s',
    async (reason) => {
      health.isHealthy = false;
      health.status = 'unhealthy';
      health.ingestion.healthy = false;
      health.ingestion.reason = reason;
      health.ingestion.sampled = reason !== 'not_sampled';

      const response = await request(app).get('/health/monitor-ready').expect(503);
      expect(response.body).toMatchObject({
        ready: false,
        status: 'not_ready',
        checks: {
          rpc: { ok: false, gating: false },
          monitoring: { ok: false, ingestion: { healthy: false, reason } },
        },
      });
    },
  );

  it('stays ready through primary recovery and failback, but still gates ingestion', async () => {
    await request(app).get('/health/monitor-ready').expect(200);
    getBlockNumber.mockResolvedValue(102);
    // A recovered primary does not imply that failback has happened yet.
    const backup = await request(app).get('/health/monitor-ready').expect(200);
    expect(backup.body.checks.monitoring.ingestion.usingBackupProvider).toBe(true);

    health.ingestion.usingBackupProvider = false;
    const primary = await request(app).get('/health/monitor-ready').expect(200);
    expect(primary.body.checks.rpc).toMatchObject({
      ok: true,
      chainId: '11155111',
      blockNumber: 102,
    });
    expect(primary.body.checks.monitoring.ingestion.usingBackupProvider).toBe(false);

    health.isHealthy = false;
    health.ingestion.healthy = false;
    const failed = await request(app).get('/health/monitor-ready').expect(503);
    expect(failed.body.checks.rpc.ok).toBe(true);
    expect(failed.body.ready).toBe(false);
  });

  it('still requires Redis while healthy on backup', async () => {
    ping.mockRejectedValue(new Error('Redis unavailable'));
    const response = await request(app).get('/health/monitor-ready').expect(503);
    expect(response.body.checks.redis).toEqual({ ok: false, error: 'Redis unavailable' });
    expect(response.body.checks.monitoring.ok).toBe(true);
  });

  it('keeps configured-primary and signer checks gating for general readiness', async () => {
    const readiness = await getReadiness(context);
    expect(readiness.ready).toBe(false);
    expect(readiness.checks).toMatchObject({
      rpc: { ok: false, gating: true },
      signer: { ok: false, error: 'backend signer is not initialized' },
      deltaVerifier: { ok: false },
      monitoring: { ok: true },
    });
    expect(getBackendSigner).toHaveBeenCalled();
  });
});
