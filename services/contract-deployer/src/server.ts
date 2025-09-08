import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createClient } from 'redis';
import { QueueService } from './services/queue.service';
import { BlockchainService } from './services/blockchain.service';
import { DeploymentService } from './services/deployment.service';
import { DeploymentProcessor } from './services/deployment-processor';
import { ContractDeployer } from './blockchain/contract-deployer';
import { deploymentRouter } from './routes/deployments';
import { healthRouter } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { rateLimiter } from './middleware/rate-limiter';
import { createLogger } from './utils/logger';
import { validateEnv, type Config } from './config/env.validation';

// Load environment variables
dotenv.config();

const logger = createLogger('server');

async function createServer(): Promise<express.Application> {
  // Validate environment variables (including SSM parameters if enabled)
  const config: Config = await validateEnv();
  
  // Initialize services
  const redisClient = createClient({
    socket: {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
    },
  });

  await redisClient.connect();
  logger.info('Connected to Redis');

  // Initialize queue service
  const queueService = new QueueService(
    config.REDIS_HOST,
    config.REDIS_PORT,
    logger
  );
  await queueService.connect();

  // Initialize blockchain service
  const blockchainService = new BlockchainService(
    config.RPC_URL,
    config.DEPLOYER_PRIVATE_KEY,
    logger
  );

  // Initialize contract deployer
  const contractDeployer = new ContractDeployer({
    rpcUrls: [config.RPC_URL], // Add more URLs if needed
    privateKey: config.DEPLOYER_PRIVATE_KEY,
    tokenManagerAddress: config.TOKEN_MANAGER_ADDRESS,
    modelRegistryAddress: config.MODEL_REGISTRY_ADDRESS,
    gasMultiplier: config.GAS_PRICE_MULTIPLIER,
    maxGasPrice: (config.MAX_GAS_PRICE_GWEI * 1e9).toString(), // Convert Gwei to Wei
    confirmations: config.CONFIRMATION_BLOCKS
  });

  // Initialize deployment service
  const deploymentService = new DeploymentService(
    {
      redisHost: config.REDIS_HOST,
      redisPort: config.REDIS_PORT,
      queueName: config.QUEUE_NAME,
      statusTtlSeconds: 86400, // 24 hours
      maxConcurrentDeployments: 10 // Default value
    },
    queueService,
    contractDeployer
  );
  await deploymentService.initialize();

  // Initialize deployment processor
  const deploymentProcessor = new DeploymentProcessor(
    queueService,
    blockchainService,
    deploymentService,
    logger,
    config
  );

  // Start background processing
  await deploymentProcessor.start();
  logger.info('Deployment processor started');

  // Create Express app
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
  }));

  // Rate limiting
  app.use(rateLimiter);

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      correlationId: req.headers['x-correlation-id']
    });
    next();
  });

  // API routes
  app.use('/api/deployments', deploymentRouter(
    queueService,
    blockchainService,
    deploymentService
  ));
  
  app.use('/health', healthRouter());

  // Default route
  app.get('/', (req, res) => {
    res.json({
      name: 'Hokusai Contract Deployer API',
      version: '1.0.0',
      status: 'running',
      timestamp: new Date().toISOString(),
      endpoints: {
        deployments: '/api/deployments',
        health: '/health'
      }
    });
  });

  // 404 handler
  app.use('*', (req, res) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.path} not found`,
        timestamp: new Date().toISOString()
      }
    });
  });

  // Error handling middleware (must be last)
  app.use(errorHandler);

  return app;
}

async function startServer(): Promise<void> {
  try {
    const config: Config = await validateEnv();
    const app = await createServer();
    
    const port = config.PORT;
    const server = app.listen(port, () => {
      logger.info(`Hokusai Contract Deployer API listening on port ${port}`);
      logger.info(`API endpoints available at http://localhost:${port}/api`);
      logger.info(`Health checks available at http://localhost:${port}/health`);
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);
      
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // TODO: Stop deployment processor and clean up services
      
      logger.info('Graceful shutdown completed');
      process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { promise, reason });
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error });
  process.exit(1);
});

// Start the server
if (require.main === module) {
  void startServer();
}

export { createServer };