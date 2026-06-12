/**
 * Standalone Monitoring Server
 *
 * This server runs ONLY the AMM monitoring components without
 * requiring Redis, Queue services, or deployer functionality.
 */

import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { KMSClient } from '@aws-sdk/client-kms';
import { ethers } from 'ethers';
import { createClient, RedisClientType } from 'redis';
import { AMMMonitor } from './monitoring/amm-monitor';
import { monitoringRouter } from './routes/monitoring';
import { reconciliationRouter } from './routes/reconciliation';
import { logger } from './utils/logger';
import { CostReconciliationService } from './monitoring/cost-reconciliation-service';
import { KmsSigner } from './blockchain/kms-signer';
import { getBackendSigner, setBackendSigner } from './blockchain/signer-singleton';

// Load environment variables
dotenv.config();

async function initializeBackendSigner(
  provider: ethers.JsonRpcProvider,
): Promise<ethers.Signer | null> {
  const existingSigner = getBackendSigner();
  if (existingSigner) {
    return existingSigner;
  }

  if (process.env.KMS_BACKEND_KEY_ID && process.env.KMS_BACKEND_EXPECTED_ADDRESS) {
    const signer = await KmsSigner.fromKeyId({
      client: new KMSClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
      keyId: process.env.KMS_BACKEND_KEY_ID,
      provider,
    });
    const derivedAddress = ethers.getAddress(await signer.getAddress());
    const expectedAddress = ethers.getAddress(process.env.KMS_BACKEND_EXPECTED_ADDRESS);
    if (derivedAddress !== expectedAddress) {
      throw new Error(
        `KMS backend address pin mismatch: derived=${derivedAddress}, expected=${expectedAddress}, alias=${process.env.KMS_BACKEND_KEY_ID}`,
      );
    }
    setBackendSigner(signer);
    return signer;
  }

  if (process.env.DEPLOYER_PRIVATE_KEY) {
    const signer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    setBackendSigner(signer);
    return signer;
  }

  return null;
}

async function main(): Promise<void> {
  let redis: RedisClientType | null = null;

  try {
    logger.info('[MONITORING-SERVER] Starting AMM Monitoring Service...');
    logger.info(`[MONITORING-SERVER] Node version: ${process.version}`);
    logger.info(`[MONITORING-SERVER] NODE_ENV: ${process.env.NODE_ENV}`);

    // Validate required environment variables
    const requiredVars = [
      'RPC_URL',
      'FACTORY_ADDRESS',
      'USDC_ADDRESS',
      'ALERT_EMAIL_FROM',
      'ALERT_EMAIL_TO',
      'AWS_REGION',
    ];

    const missing = requiredVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Create Ethereum provider
    logger.info('[MONITORING-SERVER] Creating Ethereum provider...');
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const network = await provider.getNetwork();
    logger.info(
      `[MONITORING-SERVER] Connected to network: ${network.name} (chainId: ${network.chainId})`,
    );
    await initializeBackendSigner(provider);

    if (process.env.REDIS_URL) {
      try {
        logger.info('[MONITORING-SERVER] Connecting to Redis for readiness checks...');
        redis = createClient({ url: process.env.REDIS_URL });
        await Promise.race([
          redis.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Redis connection timeout')), 5000),
          ),
        ]);
        logger.info('[MONITORING-SERVER] Redis connected');
      } catch (error) {
        logger.warn(
          '[MONITORING-SERVER] Redis connection failed; readiness will report degraded',
          error,
        );
        if (redis) {
          await redis.disconnect().catch(() => undefined);
        }
        redis = null;
      }
    } else {
      logger.warn('[MONITORING-SERVER] REDIS_URL not set; queue readiness checks disabled');
    }

    // Initialize AMM Monitor (it creates AlertManager internally)
    logger.info('[MONITORING-SERVER] Initializing AMM Monitor...');

    // Set environment variables for monitoring config
    process.env.SEPOLIA_RPC_URL = process.env.RPC_URL;
    process.env.NETWORK = process.env.NETWORK || 'sepolia';

    const { createMonitoringConfig } = await import('./config/monitoring-config');
    const monitoringConfig = createMonitoringConfig();

    const ammMonitor = new AMMMonitor(monitoringConfig);

    // Start monitoring
    logger.info('[MONITORING-SERVER] Starting AMM monitoring...');
    await ammMonitor.start();

    // Initialize Cost Reconciliation Service
    logger.info('[MONITORING-SERVER] Initializing Cost Reconciliation Service...');
    const reconciliationService = new CostReconciliationService({
      provider,
      infraReserveAddress: process.env.INFRASTRUCTURE_RESERVE_ADDRESS || '',
      infraCostOracleAddress: process.env.INFRASTRUCTURE_COST_ORACLE_ADDRESS,
      // alertManager: ammMonitor.getAlertManager(), // Will be available when AMMMonitor exposes it
      varianceWarningPercent: parseFloat(process.env.COST_VARIANCE_WARNING_PCT || '10'),
      varianceCriticalPercent: parseFloat(process.env.COST_VARIANCE_CRITICAL_PCT || '20'),
      runwayWarningDays: parseInt(process.env.RUNWAY_WARNING_DAYS || '7'),
      runwayCriticalDays: parseInt(process.env.RUNWAY_CRITICAL_DAYS || '3'),
      reconciliationIntervalMs: parseInt(process.env.RECONCILIATION_INTERVAL_MS || '86400000'), // Daily
    });

    // Start reconciliation service if infrastructure reserve address is configured
    if (process.env.INFRASTRUCTURE_RESERVE_ADDRESS) {
      try {
        logger.info('[MONITORING-SERVER] Starting Cost Reconciliation Service...');
        await reconciliationService.start();
      } catch (error) {
        logger.error('[MONITORING-SERVER] Failed to start Cost Reconciliation Service:', error);
        logger.warn('[MONITORING-SERVER] Continuing without reconciliation service');
      }
    } else {
      logger.warn(
        '[MONITORING-SERVER] INFRASTRUCTURE_RESERVE_ADDRESS not set, reconciliation service disabled',
      );
    }

    // Create Express app
    const app = express();
    const port = process.env.PORT || 8002;

    // Middleware
    app.use(helmet());
    app.use(
      cors({
        origin: process.env.CORS_ORIGINS?.split(',') || '*',
        credentials: true,
      }),
    );
    app.use(express.json());

    // Request logging
    app.use((req: Request, _res: Response, next) => {
      logger.debug(`${req.method} ${req.path}`);
      next();
    });

    // Health check endpoint
    app.get('/health', async (_req: Request, res: Response) => {
      const health = ammMonitor.getHealth();
      res.status(health.isHealthy ? 200 : 503).json({
        status: health.isHealthy ? 'healthy' : 'unhealthy',
        uptime: health.uptime,
        components: health.components,
        timestamp: new Date().toISOString(),
      });
    });

    app.get('/health/ready', async (_req: Request, res: Response) => {
      const readiness = await getReadiness({
        ammMonitor,
        provider,
        networkChainId: network.chainId,
        redis,
      });

      res.status(readiness.ready ? 200 : 503).json(readiness);
    });

    // Monitoring API routes
    app.use('/api/monitoring', monitoringRouter(ammMonitor));

    // Reconciliation API routes
    app.use('/api/reconciliation', reconciliationRouter(reconciliationService));

    // 404 handler
    app.use((_req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Endpoint not found',
          timestamp: new Date().toISOString(),
        },
      });
    });

    // Start server
    app.listen(port, () => {
      logger.info(`[MONITORING-SERVER] ✅ Monitoring server running on port ${port}`);
      logger.info(`[MONITORING-SERVER] Health: http://localhost:${port}/health`);
      logger.info(`[MONITORING-SERVER] API: http://localhost:${port}/api/monitoring`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('[MONITORING-SERVER] SIGTERM received, shutting down gracefully...');
      await reconciliationService.stop();
      await ammMonitor.stop();
      if (redis) {
        await redis.quit();
      }
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('[MONITORING-SERVER] SIGINT received, shutting down gracefully...');
      await reconciliationService.stop();
      await ammMonitor.stop();
      if (redis) {
        await redis.quit();
      }
      process.exit(0);
    });
  } catch (error) {
    logger.error('[MONITORING-SERVER] Fatal error:', error);
    process.exit(1);
  }
}

interface ReadinessContext {
  ammMonitor: AMMMonitor;
  provider: ethers.JsonRpcProvider;
  networkChainId: bigint;
  redis: RedisClientType | null;
}

async function getReadiness({
  ammMonitor,
  provider,
  networkChainId,
  redis,
}: ReadinessContext): Promise<Record<string, unknown> & { ready: boolean }> {
  const checks: Record<string, unknown> = {};
  let ready = true;

  try {
    const blockNumber = await provider.getBlockNumber();
    checks.rpc = {
      ok: true,
      chainId: networkChainId.toString(),
      blockNumber,
    };
  } catch (error) {
    ready = false;
    checks.rpc = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const signerCheck = await getSignerReadiness(provider);
  checks.signer = signerCheck;
  if (!signerCheck.ok) {
    ready = false;
  }

  const roleCheck = await getDeltaVerifierRoleReadiness(provider, signerCheck.address);
  checks.deltaVerifier = roleCheck;
  if (!roleCheck.ok) {
    ready = false;
  }

  const redisCheck = await getRedisReadiness(redis);
  checks.redis = redisCheck;
  if (!redisCheck.ok) {
    ready = false;
  }

  const health = ammMonitor.getHealth();
  checks.monitoring = {
    ok: health.isHealthy,
    status: health.status,
    poolsMonitored: health.poolsMonitored,
    components: health.components,
  };
  if (!health.isHealthy) {
    ready = false;
  }

  return {
    ready,
    status: ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks,
  };
}

async function getSignerReadiness(
  provider: ethers.JsonRpcProvider,
): Promise<{ ok: boolean; address?: string; balanceWei?: string; error?: string }> {
  try {
    const signer = getBackendSigner();
    if (!signer) {
      return { ok: false, error: 'backend signer is not initialized' };
    }

    const signerAddress = await signer.getAddress();
    const balance = await provider.getBalance(signerAddress);

    return {
      ok: balance > 0n,
      address: signerAddress,
      balanceWei: balance.toString(),
      ...(balance > 0n ? {} : { error: 'signer balance is zero' }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getDeltaVerifierRoleReadiness(
  provider: ethers.JsonRpcProvider,
  signerAddress?: string,
): Promise<{
  ok: boolean;
  address?: string;
  signer?: string;
  hasSubmitterRole?: boolean;
  error?: string;
}> {
  try {
    const deltaVerifierAddress = process.env.DELTA_VERIFIER_ADDRESS;
    if (!deltaVerifierAddress) {
      return { ok: false, error: 'DELTA_VERIFIER_ADDRESS is not set' };
    }
    if (!signerAddress) {
      return {
        ok: false,
        address: deltaVerifierAddress,
        error: 'signer address unavailable',
      };
    }

    const deltaVerifier = new ethers.Contract(
      deltaVerifierAddress,
      [
        'function SUBMITTER_ROLE() view returns (bytes32)',
        'function hasRole(bytes32 role, address account) view returns (bool)',
      ],
      provider,
    ) as ethers.Contract & {
      SUBMITTER_ROLE(): Promise<string>;
      hasRole(role: string, account: string): Promise<boolean>;
    };
    const submitterRole = await deltaVerifier.SUBMITTER_ROLE();
    const hasSubmitterRole = await deltaVerifier.hasRole(submitterRole, signerAddress);

    return {
      ok: hasSubmitterRole,
      address: deltaVerifierAddress,
      signer: signerAddress,
      hasSubmitterRole,
      ...(hasSubmitterRole ? {} : { error: 'signer lacks SUBMITTER_ROLE' }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getRedisReadiness(
  redis: RedisClientType | null,
): Promise<{ ok: boolean; queues?: Record<string, number>; error?: string }> {
  if (!redis) {
    return { ok: false, error: 'Redis is not connected' };
  }

  try {
    await redis.ping();
    const queueNames = {
      mintRequest: process.env.MINT_REQUEST_QUEUE || 'hokusai:mint_requests',
      mintRequestProcessing:
        process.env.MINT_REQUEST_PROCESSING_QUEUE || 'hokusai:mint_requests:processing',
      mintRequestDlq: process.env.MINT_REQUEST_DLQ || 'hokusai:mint_requests:dlq',
      mintRequestSettlement:
        process.env.MINT_REQUEST_SETTLEMENT_QUEUE || 'hokusai:mint_request_settlements',
    };
    const queueDepths: Record<string, number> = {};

    for (const [name, queue] of Object.entries(queueNames)) {
      queueDepths[name] = await redis.lLen(queue);
    }

    return {
      ok: true,
      queues: queueDepths,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Start the server
main().catch((error) => {
  logger.error('[MONITORING-SERVER] Unhandled error:', error);
  process.exit(1);
});
