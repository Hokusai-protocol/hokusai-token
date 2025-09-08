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

    // Initialize the contract deploy listener
    const listener = new ContractDeployListener({
      redis: {
        url: config.REDIS_URL || `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`
      },
      blockchain: {
        rpcUrls: config.RPC_URL.split(','),
        privateKey: config.DEPLOYER_PRIVATE_KEY,
        tokenManagerAddress: config.TOKEN_MANAGER_ADDRESS,
        modelRegistryAddress: config.MODEL_REGISTRY_ADDRESS,
        gasMultiplier: config.GAS_PRICE_MULTIPLIER,
        maxGasPrice: (config.MAX_GAS_PRICE_GWEI * 1e9).toString(), // Convert Gwei to Wei
        confirmations: config.CONFIRMATION_BLOCKS
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
    const redisUrl = config.REDIS_URL || `redis://${config.REDIS_HOST}:${config.REDIS_PORT}`;
    const redis = createClient({ url: redisUrl });
    await redis.connect();

    // Create provider for health checks
    const provider = new ethers.JsonRpcProvider(config.RPC_URL.split(',')[0]);

    // Initialize health check service
    const healthCheck = new HealthCheckService({
      redis,
      provider,
      registryAddress: config.MODEL_REGISTRY_ADDRESS,
      tokenManagerAddress: config.TOKEN_MANAGER_ADDRESS
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

    const port = config.PORT;
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