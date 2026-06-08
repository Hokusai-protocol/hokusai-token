import { Router } from 'express';
import { ethers } from 'ethers';
import { createClient } from 'redis';

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

      const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
      if (!privateKey) {
        ready = false;
        checks.signer = { ok: false, error: 'DEPLOYER_PRIVATE_KEY is not configured' };
      } else {
        const wallet = new ethers.Wallet(privateKey, provider);
        const balance = await withTimeout(
          provider.getBalance(wallet.address),
          5000,
          'Signer balance check timeout',
        );
        checks.signer = {
          ok: balance > 0n,
          address: wallet.address,
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
            deltaVerifier.hasRole(role, wallet.address),
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

  router.get('/ready', async (_req, res) => {
    const readiness = await checkReadiness();
    res.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: readiness.checks,
    });
  });

  return router;
}
