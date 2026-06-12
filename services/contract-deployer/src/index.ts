import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ContractDeployListener } from './contract-deploy-listener';
import { MintRequestListener } from './mint-request-listener';
import { HealthCheckService } from './monitoring/health-check';
import { logger } from './utils/logger';
import { createClient } from 'redis';
import { ethers } from 'ethers';
import { createBackendSigner } from './blockchain/signer-factory';
import { setBackendSigner } from './blockchain/signer-singleton';
import { asyncHandler } from './middleware/async-handler';

// Load environment variables
dotenv.config();

async function main(): Promise<void> {
  try {
    logger.info('Starting Contract Deployer Service...');

    // Load configuration (including SSM parameters if enabled)
    const { validateEnv } = await import('./config/env.validation');
    const config = await validateEnv();

    // For backward compatibility, also set environment variables from config
    if (config.REDIS_URL) {
      process.env.REDIS_URL = config.REDIS_URL;
    }
    if (!process.env.RPC_URLS) {
      process.env.RPC_URLS = config.RPC_URL;
    }

    const provider = new ethers.JsonRpcProvider(config.RPC_URL.split(',')[0]);
    const signer = await createBackendSigner(config, provider);
    setBackendSigner(signer);

    // Try to initialize the contract deploy listener (with optional Redis)
    let listener: ContractDeployListener | null = null;
    let mintListener: MintRequestListener | null = null;
    let redisConnected = false;

    try {
      listener = new ContractDeployListener({
        redis: {
          url: config.REDIS_URL || `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`,
        },
        blockchain: {
          rpcUrls: config.RPC_URL.split(','),
          signer,
          tokenManagerAddress: config.TOKEN_MANAGER_ADDRESS,
          modelRegistryAddress: config.MODEL_REGISTRY_ADDRESS,
          gasMultiplier: config.GAS_PRICE_MULTIPLIER,
          maxGasPrice: (config.MAX_GAS_PRICE_GWEI * 1e9).toString(),
          confirmations: config.CONFIRMATION_BLOCKS,
          deploymentParams: {
            modelSupplierAllocation: BigInt(config.MODEL_SUPPLIER_ALLOCATION),
            modelSupplierRecipient: config.MODEL_SUPPLIER_RECIPIENT,
            investorAllocation: BigInt(config.INVESTOR_ALLOCATION),
            tokensPerDeltaOne: BigInt(config.TOKENS_PER_DELTA_ONE),
            infrastructureAccrualBps: config.INFRASTRUCTURE_ACCRUAL_BPS,
            initialOraclePricePerThousandUsd: BigInt(config.INITIAL_ORACLE_PRICE_PER_THOUSAND_USD),
            licenseHash: config.LICENSE_HASH,
            licenseURI: config.LICENSE_URI,
            governor: config.GOVERNOR_ADDRESS,
          },
        },
        queues: {
          inbound: process.env.INBOUND_QUEUE || 'hokusai:model_ready_queue',
          outbound: process.env.OUTBOUND_QUEUE || 'hokusai:token_deployed_queue',
          processing: process.env.PROCESSING_QUEUE || 'hokusai:processing_queue',
          deadLetter: process.env.DLQ_NAME || 'hokusai:dlq',
        },
      });

      // Initialize the listener with timeout
      const initPromise = listener.initialize();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000),
      );

      await Promise.race([initPromise, timeoutPromise]);
      redisConnected = true;
      logger.info('Contract Deploy Listener initialized with Redis');
    } catch (error) {
      logger.warn('Failed to initialize Contract Deploy Listener with Redis', error);
      logger.info('Continuing without queue functionality');
      listener = null;
    }

    if (config.DELTA_VERIFIER_ADDRESS) {
      try {
        mintListener = new MintRequestListener({
          redis: {
            url: config.REDIS_URL || `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`,
          },
          blockchain: {
            rpcUrls: config.RPC_URL.split(','),
            signer,
            deltaVerifierAddress: config.DELTA_VERIFIER_ADDRESS,
            modelRegistryAddress: config.MODEL_REGISTRY_ADDRESS,
            confirmations: config.CONFIRMATION_BLOCKS,
            gasMultiplier: config.GAS_PRICE_MULTIPLIER,
            maxGasPrice: (config.MAX_GAS_PRICE_GWEI * 1e9).toString(),
          },
          queues: {
            inbound: config.MINT_REQUEST_QUEUE,
            processing: config.MINT_REQUEST_PROCESSING_QUEUE,
            deadLetter: config.MINT_REQUEST_DLQ,
            processedSet: config.MINT_REQUEST_PROCESSED_SET,
            retry: config.MINT_REQUEST_RETRY_QUEUE,
            settlements: config.MINT_REQUEST_SETTLEMENT_QUEUE,
            maxRetries: config.MINT_REQUEST_MAX_RETRIES,
            budgetMaxRetries: config.MINT_REQUEST_BUDGET_MAX_RETRIES,
            backoffBaseMs: config.MINT_BACKOFF_BASE_MS,
            backoffMaxMs: config.MINT_BACKOFF_MAX_MS,
            budgetRetryBackoffBaseMs: config.MINT_BUDGET_BACKOFF_BASE_MS,
            budgetRetryBackoffMaxMs: config.MINT_BUDGET_BACKOFF_MAX_MS,
            backoffMultiplier: config.MINT_BACKOFF_MULTIPLIER,
            recordKeyPrefix: config.MINT_RECORD_KEY_PREFIX,
            recordTtlSeconds: config.MINT_RECORD_TTL_SECONDS,
          },
        });

        await mintListener.initialize();
        logger.info('MintRequest Listener initialized with Redis');
      } catch (error) {
        logger.warn('Failed to initialize MintRequest Listener', error);
        mintListener = null;
      }
    }

    // Set up Express app for health checks
    const app = express();
    app.use(helmet());
    app.use(cors());

    // Create Redis client for health checks (optional)
    let redis: any = null;
    try {
      const redisUrl = config.REDIS_URL || `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`;
      redis = createClient({ url: redisUrl });
      const connectPromise = redis.connect();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000),
      );
      await Promise.race([connectPromise, timeoutPromise]);
      logger.info('Redis connected for health checks');
    } catch (error) {
      logger.warn('Redis not available for health checks', error);
      redis = null;
    }

    // Create provider for health checks
    // Initialize health check service
    const healthCheck = new HealthCheckService({
      redis,
      provider,
      registryAddress: config.MODEL_REGISTRY_ADDRESS,
      tokenManagerAddress: config.TOKEN_MANAGER_ADDRESS,
    });

    // Set up health check endpoints
    app.get('/health', healthCheck.getHealthHandler());
    app.get('/health/detailed', healthCheck.getDetailedHealthHandler());
    app.get('/health/live', (_req, res) => {
      res.json({ alive: true });
    });
    app.get(
      '/health/ready',
      asyncHandler(async (_req, res) => {
        const ready = await healthCheck.isReady();
        res.status(ready ? 200 : 503).json({ ready });
      }),
    );

    const port = config.PORT;
    const server = app.listen(port, () => {
      logger.info(`Health check server listening on port ${port}`);
    });

    // Start processing messages if Redis is available
    let processingPromise: Promise<void> | null = null;
    let mintProcessingPromise: Promise<void> | null = null;
    if (listener && redisConnected) {
      processingPromise = listener.start();
      logger.info('Contract Deployer Service started successfully with queue processing');
    } else {
      logger.info(
        'Contract Deployer Service started successfully (API only mode, no queue processing)',
      );
    }
    if (mintListener) {
      mintProcessingPromise = mintListener.start();
      logger.info('MintRequest processing started');
    }

    // Setup graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop the listener if it exists
      if (listener) {
        listener.stop();
      }
      if (mintListener) {
        mintListener.stop();
      }

      // Wait for message processing to complete if it was started
      if (processingPromise) {
        await processingPromise;
      }
      if (mintProcessingPromise) {
        await mintProcessingPromise;
      }

      // Clean up resources
      if (listener) {
        await listener.cleanup();
      }
      if (mintListener) {
        await mintListener.cleanup();
      }
      if (redis) {
        await redis.quit();
      }

      logger.info('Graceful shutdown completed');
      process.exit(0);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => {
      void gracefulShutdown('SIGTERM').catch((shutdownError) => {
        logger.error('Graceful shutdown failed', shutdownError);
        process.exit(1);
      });
    });
    process.on('SIGINT', () => {
      void gracefulShutdown('SIGINT').catch((shutdownError) => {
        logger.error('Graceful shutdown failed', shutdownError);
        process.exit(1);
      });
    });
  } catch (error) {
    logger.error('Failed to start service', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the application
void main();
