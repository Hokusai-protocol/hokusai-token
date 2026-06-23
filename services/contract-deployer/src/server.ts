// Early startup logging
console.log('[STARTUP] Server.ts starting...');
console.log('[STARTUP] Node version:', process.version);
console.log('[STARTUP] NODE_ENV:', process.env.NODE_ENV);

import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createClient } from 'redis';
import { ethers } from 'ethers';
import { QueueService } from './services/queue.service';
import { BlockchainService } from './services/blockchain.service';
import { DeploymentService } from './services/deployment.service';
import { DeploymentProcessor } from './services/deployment-processor';
import { ContractDeployer } from './blockchain/contract-deployer';
import { deploymentRouter } from './routes/deployments';
import { healthRouter } from './routes/health';
import { monitoringRouter } from './routes/monitoring';
import { errorHandler } from './middleware/error-handler';
import { rateLimiter } from './middleware/rate-limiter';
import { createLogger } from './utils/logger';
import { validateEnv, type Config } from './config/env.validation';
import { AMMMonitor } from './monitoring/amm-monitor';
import { createMonitoringConfig } from './config/monitoring-config';
import { MintRequestListener } from './mint-request-listener';
import { createBackendSigner } from './blockchain/signer-factory';
import { setBackendSigner } from './blockchain/signer-singleton';
import { installGlobalErrorHandlers } from './utils/process-handlers';

// Load environment variables
dotenv.config();
console.log('[STARTUP] Environment variables loaded');

const logger = createLogger('server');
console.log('[STARTUP] Logger created');

interface ServerContext {
  config: Config;
  provider: ethers.JsonRpcProvider;
  signer: ethers.Signer;
}

async function createServer(context?: ServerContext): Promise<express.Application> {
  console.log('[STARTUP] createServer() called');

  // Validate environment variables (including SSM parameters if enabled)
  let config: Config;
  let provider: ethers.JsonRpcProvider;
  let signer: ethers.Signer;
  if (context) {
    ({ config, provider, signer } = context);
  } else {
    console.log('[STARTUP] Validating environment...');
    config = await validateEnv();
    console.log('[STARTUP] Environment validated successfully');
    provider = new ethers.JsonRpcProvider(config.RPC_URL);
    signer = await createBackendSigner(config, provider);
    setBackendSigner(signer);
  }

  // Initialize services
  console.log('[STARTUP] Creating Redis client...');
  console.log('[STARTUP] Redis host:', config.REDIS_HOST);
  console.log('[STARTUP] Redis port:', config.REDIS_PORT);

  const redisClient = createClient(
    config.REDIS_URL
      ? {
          url: config.REDIS_URL,
        }
      : {
          socket: {
            host: config.REDIS_HOST,
            port: config.REDIS_PORT,
          },
        },
  );
  // Prevent an unhandled 'error' on a Redis socket drop from crashing the process (B2). node-redis
  // auto-reconnects; we just need a listener so the EventEmitter does not rethrow.
  redisClient.on('error', (err: unknown) => {
    logger.error('Redis client error (api server)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  console.log('[STARTUP] Connecting to Redis...');
  try {
    // Set a timeout for Redis connection
    const connectPromise = redisClient.connect();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis connection timeout')), 5000),
    );

    await Promise.race([connectPromise, timeoutPromise]);
    console.log('[STARTUP] Redis connected successfully');
    logger.info('Connected to Redis');
  } catch (error) {
    console.error('[STARTUP] Failed to connect to Redis:', error);
    console.log('[STARTUP] Continuing without Redis - queue features will be disabled');
    logger.warn('Starting without Redis - queue features disabled');
    // Don't throw - continue without Redis
  }

  // Initialize queue service (optional)
  let queueService: QueueService | null = null;
  try {
    queueService = new QueueService(config.REDIS_HOST, config.REDIS_PORT, logger, config.REDIS_URL);
    await Promise.race([
      queueService.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Queue connection timeout')), 5000),
      ),
    ]);
    console.log('[STARTUP] Queue service connected');
  } catch (error) {
    console.error('[STARTUP] Failed to connect queue service:', error);
    console.log('[STARTUP] Continuing without queue service');
    queueService = null;
  }

  // Initialize blockchain service
  const blockchainService = new BlockchainService(provider, signer, logger);

  // Initialize contract deployer
  const contractDeployer = new ContractDeployer({
    rpcUrls: [config.RPC_URL],
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
  });

  // Initialize deployment service (only if queue is available)
  let deploymentService: DeploymentService | null = null;
  let deploymentProcessor: DeploymentProcessor | null = null;

  if (queueService) {
    deploymentService = new DeploymentService(
      {
        redisHost: config.REDIS_HOST,
        redisPort: config.REDIS_PORT,
        redisUrl: config.REDIS_URL,
        queueName: config.QUEUE_NAME,
        statusTtlSeconds: 86400, // 24 hours
        maxConcurrentDeployments: 10, // Default value
      },
      queueService,
      contractDeployer,
    );

    try {
      await deploymentService.initialize();
      console.log('[STARTUP] Deployment service initialized');

      // Initialize deployment processor
      deploymentProcessor = new DeploymentProcessor(
        queueService,
        blockchainService,
        deploymentService,
        logger,
        config,
      );

      // Start background processing
      deploymentProcessor.start();
      console.log('[STARTUP] Deployment processor started');
      logger.info('Deployment processor started');
    } catch (error) {
      console.error('[STARTUP] Failed to initialize deployment services:', error);
      deploymentService = null;
      deploymentProcessor = null;
    }
  } else {
    console.log('[STARTUP] Skipping deployment service initialization (no queue)');
  }

  // Initialize AMM monitoring (optional)
  let ammMonitor: AMMMonitor | null = null;
  if (process.env.MONITORING_ENABLED === 'true') {
    try {
      console.log('[STARTUP] Initializing AMM monitoring...');
      const monitoringConfig = createMonitoringConfig();
      ammMonitor = new AMMMonitor(monitoringConfig);
      await ammMonitor.start();
      console.log('[STARTUP] AMM monitoring started successfully');
      logger.info('AMM monitoring initialized and started');
    } catch (error) {
      console.error('[STARTUP] Failed to initialize AMM monitoring:', error);
      logger.warn('AMM monitoring disabled due to initialization error', { error });
      ammMonitor = null;
    }
  } else {
    console.log('[STARTUP] AMM monitoring disabled (MONITORING_ENABLED != true)');
  }

  // Create Express app
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(
    cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      credentials: true,
    }),
  );

  // Rate limiting - 100 requests per 15 minutes
  app.use(rateLimiter(15 * 60 * 1000, 100));

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      correlationId: req.headers['x-correlation-id'],
    });
    next();
  });

  // API routes - only enable deployment routes if queue is available
  if (queueService && deploymentService) {
    app.use(
      '/api/deployments',
      deploymentRouter(queueService, blockchainService, deploymentService),
    );
  } else {
    app.use('/api/deployments', (_req, res) => {
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Deployment service is not available (Redis connection required)',
          timestamp: new Date().toISOString(),
        },
      });
    });
  }

  app.use('/health', healthRouter());

  // Monitoring routes (only if monitoring is enabled)
  if (ammMonitor) {
    app.use('/api/monitoring', monitoringRouter(ammMonitor));
  } else {
    app.use('/api/monitoring', (_req, res) => {
      res.status(503).json({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'AMM monitoring is not enabled',
          timestamp: new Date().toISOString(),
        },
      });
    });
  }

  // Default route
  app.get('/', (_req, res) => {
    res.json({
      name: 'Hokusai Contract Deployer API',
      version: '1.0.0',
      status: 'running',
      timestamp: new Date().toISOString(),
      endpoints: {
        deployments: '/api/deployments',
        monitoring: '/api/monitoring',
        health: '/health',
      },
    });
  });

  // 404 handler
  app.use('*', (req, res) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.path} not found`,
        timestamp: new Date().toISOString(),
      },
    });
  });

  // Error handling middleware (must be last)
  app.use(errorHandler);

  return app;
}

async function startServer(): Promise<void> {
  console.log('[STARTUP] startServer() called');
  try {
    console.log('[STARTUP] Getting config...');
    const serverConfig: Config = await validateEnv();
    const provider = new ethers.JsonRpcProvider(serverConfig.RPC_URL.split(',')[0]);
    const signer = await createBackendSigner(serverConfig, provider);
    setBackendSigner(signer);
    console.log('[STARTUP] Creating server application...');
    const app = await createServer({ config: serverConfig, provider, signer });
    console.log('[STARTUP] Server application created');

    const port = serverConfig.PORT;
    const host = '0.0.0.0'; // Bind to all network interfaces for container accessibility
    console.log('[STARTUP] Port from config:', port);
    console.log('[STARTUP] Binding to:', host);
    console.log('[STARTUP] About to call app.listen...');
    const server = app.listen(port, host, () => {
      console.log('[STARTUP] app.listen callback called');
      console.log(`[STARTUP] Hokusai Contract Deployer API listening on ${host}:${port}`);
      console.log(`[STARTUP] API endpoints available at http://${host}:${port}/api`);
      console.log(`[STARTUP] Health checks available at http://${host}:${port}/health`);
      logger.info(`Hokusai Contract Deployer API listening on ${host}:${port}`);
      logger.info(`API endpoints available at http://${host}:${port}/api`);
      logger.info(`Health checks available at http://${host}:${port}/health`);
    });

    let mintListener: MintRequestListener | null = null;
    let mintProcessingPromise: Promise<void> | null = null;
    if (serverConfig.DELTA_VERIFIER_ADDRESS) {
      try {
        mintListener = new MintRequestListener({
          redis: {
            url:
              serverConfig.REDIS_URL ||
              `redis://${serverConfig.REDIS_HOST}:${serverConfig.REDIS_PORT}`,
          },
          blockchain: {
            rpcUrls: serverConfig.RPC_URL.split(','),
            signer,
            deltaVerifierAddress: serverConfig.DELTA_VERIFIER_ADDRESS,
            modelRegistryAddress: serverConfig.MODEL_REGISTRY_ADDRESS,
            confirmations: serverConfig.CONFIRMATION_BLOCKS,
            gasMultiplier: serverConfig.GAS_PRICE_MULTIPLIER,
            maxGasPrice: (serverConfig.MAX_GAS_PRICE_GWEI * 1e9).toString(),
          },
          queues: {
            inbound: serverConfig.MINT_REQUEST_QUEUE,
            processing: serverConfig.MINT_REQUEST_PROCESSING_QUEUE,
            deadLetter: serverConfig.MINT_REQUEST_DLQ,
            processedSet: serverConfig.MINT_REQUEST_PROCESSED_SET,
            retry: serverConfig.MINT_REQUEST_RETRY_QUEUE,
            settlements: serverConfig.MINT_REQUEST_SETTLEMENT_QUEUE,
            maxRetries: serverConfig.MINT_REQUEST_MAX_RETRIES,
            budgetMaxRetries: serverConfig.MINT_REQUEST_BUDGET_MAX_RETRIES,
            backoffBaseMs: serverConfig.MINT_BACKOFF_BASE_MS,
            backoffMaxMs: serverConfig.MINT_BACKOFF_MAX_MS,
            budgetRetryBackoffBaseMs: serverConfig.MINT_BUDGET_BACKOFF_BASE_MS,
            budgetRetryBackoffMaxMs: serverConfig.MINT_BUDGET_BACKOFF_MAX_MS,
            backoffMultiplier: serverConfig.MINT_BACKOFF_MULTIPLIER,
            recordKeyPrefix: serverConfig.MINT_RECORD_KEY_PREFIX,
            recordTtlSeconds: serverConfig.MINT_RECORD_TTL_SECONDS,
          },
          payoutIntent: serverConfig.PAYOUT_INTENT_TABLE
            ? { tableName: serverConfig.PAYOUT_INTENT_TABLE, awsRegion: serverConfig.AWS_REGION }
            : undefined,
        });

        await mintListener.initialize();
        mintProcessingPromise = mintListener.start();
        logger.info('MintRequest listener started');
      } catch (error) {
        logger.warn('MintRequest listener failed to initialize', { error });
        mintListener = null;
        mintProcessingPromise = null;
      }
    }

    // Store monitor reference for shutdown
    let monitorRef: AMMMonitor | null = null;
    if (process.env.MONITORING_ENABLED === 'true') {
      try {
        const monitoringConfig = createMonitoringConfig();
        monitorRef = new AMMMonitor(monitoringConfig);
      } catch (error) {
        logger.warn('Could not initialize monitor for graceful shutdown', { error });
      }
    }

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);

      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop AMM monitoring
      if (monitorRef) {
        try {
          await monitorRef.stop();
          logger.info('AMM monitoring stopped');
        } catch (error) {
          logger.warn('Error stopping AMM monitoring', { error });
        }
      }

      if (mintListener) {
        mintListener.stop();
      }
      if (mintProcessingPromise) {
        try {
          await mintProcessingPromise;
        } catch (error) {
          logger.warn('MintRequest listener exited during shutdown', { error });
        }
      }
      if (mintListener) {
        try {
          await mintListener.cleanup();
        } catch (error) {
          logger.warn('Error cleaning up MintRequest listener', { error });
        }
      }

      logger.info('Graceful shutdown completed');
      process.exit(0);
    };

    process.on('SIGTERM', () => {
      void gracefulShutdown('SIGTERM').catch((shutdownError) => {
        logger.error('Graceful shutdown failed', { signal: 'SIGTERM', error: shutdownError });
        process.exit(1);
      });
    });
    process.on('SIGINT', () => {
      void gracefulShutdown('SIGINT').catch((shutdownError) => {
        logger.error('Graceful shutdown failed', { signal: 'SIGINT', error: shutdownError });
        process.exit(1);
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Global crash handlers that capture the cause synchronously before exiting (HOK B2: the previous
// handlers logged via winston then exited immediately, so the cause never flushed to CloudWatch).
installGlobalErrorHandlers(logger);

// Start the server
if (require.main === module) {
  void startServer();
}

export { createServer };
