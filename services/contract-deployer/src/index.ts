import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ContractDeployListener } from './contract-deploy-listener';
import { HealthCheckService } from './monitoring/health-check';
import { logger } from './utils/logger';
import { createClient } from 'redis';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

async function main(): Promise<void> {
  try {
    logger.info('Starting Contract Deployer Service...');

    // Validate required environment variables
    const requiredEnvVars = [
      'REDIS_URL',
      'RPC_URLS',
      'DEPLOYER_PRIVATE_KEY',
      'TOKEN_MANAGER_ADDRESS',
      'MODEL_REGISTRY_ADDRESS'
    ];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    }

    // Initialize the contract deploy listener
    const listener = new ContractDeployListener({
      redis: {
        url: process.env.REDIS_URL!
      },
      blockchain: {
        rpcUrls: process.env.RPC_URLS!.split(','),
        privateKey: process.env.DEPLOYER_PRIVATE_KEY!,
        tokenManagerAddress: process.env.TOKEN_MANAGER_ADDRESS!,
        modelRegistryAddress: process.env.MODEL_REGISTRY_ADDRESS!,
        gasMultiplier: parseFloat(process.env.GAS_MULTIPLIER || '1.2'),
        maxGasPrice: process.env.MAX_GAS_PRICE || '100000000000',
        confirmations: parseInt(process.env.CONFIRMATIONS || '2')
      },
      queues: {
        inbound: process.env.INBOUND_QUEUE || 'hokusai:model_ready_queue',
        outbound: process.env.OUTBOUND_QUEUE || 'hokusai:token_deployed_queue',
        processing: process.env.PROCESSING_QUEUE || 'hokusai:processing_queue',
        deadLetter: process.env.DLQ_NAME || 'hokusai:dlq'
      }
    });

    // Initialize the listener
    await listener.initialize();

    // Set up Express app for health checks
    const app = express();
    app.use(helmet());
    app.use(cors());

    // Create Redis client for health checks
    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();

    // Create provider for health checks
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URLS!.split(',')[0]);

    // Initialize health check service
    const healthCheck = new HealthCheckService({
      redis,
      provider,
      registryAddress: process.env.MODEL_REGISTRY_ADDRESS!,
      tokenManagerAddress: process.env.TOKEN_MANAGER_ADDRESS!
    });

    // Set up health check endpoints
    app.get('/health', healthCheck.getHealthHandler());
    app.get('/health/detailed', healthCheck.getDetailedHealthHandler());
    app.get('/health/live', (req, res) => {
      res.json({ alive: true });
    });
    app.get('/health/ready', async (req, res) => {
      const ready = await healthCheck.isReady();
      res.status(ready ? 200 : 503).json({ ready });
    });

    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
      logger.info(`Health check server listening on port ${port}`);
    });

    // Start processing messages
    const processingPromise = listener.start();
    logger.info('Contract Deployer Service started successfully');

    // Setup graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`);
      
      // Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop the listener
      listener.stop();
      
      // Wait for message processing to complete
      await processingPromise;
      
      // Clean up resources
      await listener.cleanup();
      await redis.quit();
      
      logger.info('Graceful shutdown completed');
      process.exit(0);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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