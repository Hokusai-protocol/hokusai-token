import { ethers } from 'ethers';
import type { RedisClientType } from 'redis';
import type { AMMMonitor } from './amm-monitor';
import { getBackendSigner } from '../blockchain/signer-singleton';
import { asyncHandler } from '../middleware/async-handler';

interface ReadinessContext {
  ammMonitor: Pick<AMMMonitor, 'getHealth'>;
  provider: ethers.JsonRpcProvider;
  networkChainId: bigint;
  redis: RedisClientType | null;
}

interface ReadinessOptions {
  requireSignerChecks?: boolean;
  // The monitor's ingestion health already samples whichever provider is active (primary or
  // backup). Gating on the configured primary as well would fail readiness, and make ECS replace a
  // task that is healthy on the backup, during exactly the outages the backup exists for.
  requirePrimaryRpc?: boolean;
}

export async function getReadiness(
  { ammMonitor, provider, networkChainId, redis }: ReadinessContext,
  { requireSignerChecks = true, requirePrimaryRpc = true }: ReadinessOptions = {},
): Promise<Record<string, unknown> & { ready: boolean }> {
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
    if (requirePrimaryRpc) {
      ready = false;
    }
    checks.rpc = {
      ok: false,
      gating: requirePrimaryRpc,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (requireSignerChecks) {
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
    ingestion: health.ingestion,
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

export async function getRedisReadiness(
  redis: RedisClientType | null,
): Promise<{ ok: boolean; queues?: Record<string, number>; error?: string }> {
  if (!redis) {
    return { ok: false, error: 'Redis is not connected' };
  }

  try {
    if (!redis.isOpen) {
      await Promise.race([
        redis.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis reconnect timeout')), 5000),
        ),
      ]);
    }
    if (!redis.isReady) {
      return { ok: false, error: 'Redis connection is not ready' };
    }
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

// Shared by the production ECS route and regression tests; importing this module starts no server.
export function createMonitorReadinessHandler(context: ReadinessContext) {
  return asyncHandler(async (_req, res) => {
    const readiness = await getReadiness(context, {
      requireSignerChecks: false,
      requirePrimaryRpc: false,
    });
    res.status(readiness.ready ? 200 : 503).json(readiness);
  });
}
