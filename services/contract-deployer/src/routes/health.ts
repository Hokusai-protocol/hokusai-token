import { Router } from 'express';
import { ethers } from 'ethers';
import { createClient } from 'redis';
import { getBackendSigner } from '../blockchain/signer-singleton';
import { asyncHandler } from '../middleware/async-handler';
import { buildAuthSettlementCallbackConfig } from '../config/auth-callback';

const DELTA_VERIFIER_ABI = [
  'function SUBMITTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
];

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function checkReadiness() {
  const checks: Record<string, unknown> = {};
  let ready = true;

  const rpcUrl = process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    ready = false;
    checks.rpc = { ok: false, error: 'RPC_URL is not configured' };
  } else {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const [network, blockNumber] = await withTimeout(
        Promise.all([provider.getNetwork(), provider.getBlockNumber()]),
        5000,
        'RPC readiness check timeout',
      );
      checks.rpc = {
        ok: true,
        chainId: Number(network.chainId),
        blockNumber,
      };

      const signer = getBackendSigner();
      if (!signer) {
        ready = false;
        checks.signer = { ok: false, error: 'backend signer is not initialized' };
      } else {
        const signerAddress = await signer.getAddress();
        const balance = await withTimeout(
          provider.getBalance(signerAddress),
          5000,
          'Signer balance check timeout',
        );
        checks.signer = {
          ok: balance > 0n,
          address: signerAddress,
          balanceEth: ethers.formatEther(balance),
        };
        if (balance === 0n) {
          ready = false;
        }

        const deltaVerifierAddress = process.env.DELTA_VERIFIER_ADDRESS;
        if (!deltaVerifierAddress) {
          ready = false;
          checks.deltaVerifier = { ok: false, error: 'DELTA_VERIFIER_ADDRESS is not configured' };
        } else {
          const deltaVerifier = new ethers.Contract(
            deltaVerifierAddress,
            DELTA_VERIFIER_ABI,
            provider,
          ) as unknown as {
            SUBMITTER_ROLE(): Promise<string>;
            hasRole(role: string, account: string): Promise<boolean>;
          };
          const role = await withTimeout(
            deltaVerifier.SUBMITTER_ROLE(),
            5000,
            'DeltaVerifier role lookup timeout',
          );
          const hasSubmitterRole = await withTimeout(
            deltaVerifier.hasRole(role, signerAddress),
            5000,
            'DeltaVerifier submitter role check timeout',
          );
          checks.deltaVerifier = {
            ok: hasSubmitterRole,
            address: deltaVerifierAddress,
            signerHasSubmitterRole: hasSubmitterRole,
          };
          if (!hasSubmitterRole) {
            ready = false;
          }
        }
      }
    } catch (error) {
      ready = false;
      checks.rpc = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (process.env.REDIS_URL) {
    const redis = createClient({ url: process.env.REDIS_URL });
    // Swallow async socket 'error' events so a Redis blip during a health probe can't crash the
    // process (B2); operational failures are still surfaced by the try/catch below.
    redis.on('error', () => undefined);
    try {
      await withTimeout(redis.connect(), 5000, 'Redis connection timeout');
      const queueNames = [
        process.env.MINT_REQUEST_QUEUE || 'hokusai:mint_requests',
        process.env.MINT_REQUEST_PROCESSING_QUEUE || 'hokusai:mint_requests:processing',
        process.env.MINT_REQUEST_DLQ || 'hokusai:mint_requests:dlq',
        process.env.MINT_REQUEST_SETTLEMENT_QUEUE || 'hokusai:mint_request_settlements',
      ];
      const depths = Object.fromEntries(
        await Promise.all(queueNames.map(async (queue) => [queue, await redis.lLen(queue)])),
      );
      checks.redis = { ok: true, queues: depths };
    } catch (error) {
      ready = false;
      checks.redis = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await redis.disconnect().catch(() => undefined);
    }
  } else {
    ready = false;
    checks.redis = { ok: false, error: 'REDIS_URL is not configured' };
  }

  checks.contracts = {
    modelRegistry: process.env.MODEL_REGISTRY_ADDRESS || null,
    tokenManager: process.env.TOKEN_MANAGER_ADDRESS || null,
    factory: process.env.FACTORY_ADDRESS || process.env.AMM_FACTORY_ADDRESS || null,
    usdc: process.env.USDC_ADDRESS || null,
    usageFeeRouter: process.env.USAGE_FEE_ROUTER_ADDRESS || null,
    deltaVerifier: process.env.DELTA_VERIFIER_ADDRESS || null,
  };
  const authSettlementCallback = buildAuthSettlementCallbackConfig({
    HOKUSAI_AUTH_SERVICE_URL:
      process.env.HOKUSAI_AUTH_SERVICE_URL || process.env.AUTH_SERVICE_URL || '',
    HOKUSAI_AUTH_INTERNAL_TOKEN:
      process.env.HOKUSAI_AUTH_INTERNAL_TOKEN || process.env.INTERNAL_SERVICE_TOKEN || '',
    HOKUSAI_AUTH_SETTLEMENT_TIMEOUT_MS: Number(
      process.env.HOKUSAI_AUTH_SETTLEMENT_TIMEOUT_MS || 10000,
    ),
    NETWORK_NAME: process.env.NETWORK_NAME || 'sepolia',
    CHAIN_ID: Number(process.env.CHAIN_ID || 11155111),
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'test' | 'production') || 'development',
    DEPLOY_ENV: process.env.DEPLOY_ENV,
  });
  checks.authSettlementCallback = {
    enabled: authSettlementCallback.enabled,
    targetHost: authSettlementCallback.targetHost,
    reason: authSettlementCallback.reason,
  };

  return { ready, checks };
}

export function healthRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    console.log('[HEALTH] Health check requested');
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const readiness = await checkReadiness();
      res.status(readiness.ready ? 200 : 503).json({
        status: readiness.ready ? 'ready' : 'not_ready',
        timestamp: new Date().toISOString(),
        checks: readiness.checks,
      });
    }),
  );

  return router;
}
