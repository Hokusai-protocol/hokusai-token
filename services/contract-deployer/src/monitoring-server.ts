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
import { ethers } from 'ethers';
import { AMMMonitor } from './monitoring/amm-monitor';
import { monitoringRouter } from './routes/monitoring';
import { reconciliationRouter } from './routes/reconciliation';
import { logger } from './utils/logger';
import { AlertManager } from './monitoring/alert-manager';
import { CostReconciliationService } from './monitoring/cost-reconciliation-service';

// Load environment variables
dotenv.config();

async function main(): Promise<void> {
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
      'AWS_REGION'
    ];

    const missing = requiredVars.filter(v => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Create Ethereum provider
    logger.info('[MONITORING-SERVER] Creating Ethereum provider...');
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const network = await provider.getNetwork();
    logger.info(`[MONITORING-SERVER] Connected to network: ${network.name} (chainId: ${network.chainId})`);

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
      reconciliationIntervalMs: parseInt(process.env.RECONCILIATION_INTERVAL_MS || '86400000') // Daily
    });

    // Start reconciliation service if infrastructure reserve address is configured
    if (process.env.INFRASTRUCTURE_RESERVE_ADDRESS) {
      logger.info('[MONITORING-SERVER] Starting Cost Reconciliation Service...');
      await reconciliationService.start();
    } else {
      logger.warn('[MONITORING-SERVER] INFRASTRUCTURE_RESERVE_ADDRESS not set, reconciliation service disabled');
    }

    // Create Express app
    const app = express();
    const port = process.env.PORT || 8002;

    // Middleware
    app.use(helmet());
    app.use(cors({
      origin: process.env.CORS_ORIGINS?.split(',') || '*',
      credentials: true
    }));
    app.use(express.json());

    // Request logging
    app.use((req: Request, _res: Response, next) => {
      logger.debug(`${req.method} ${req.path}`);
      next();
    });

    // Health check endpoint
    app.get('/health', async (_req: Request, res: Response) => {
      const health = await ammMonitor.getHealth();
      res.status(health.isHealthy ? 200 : 503).json({
        status: health.isHealthy ? 'healthy' : 'unhealthy',
        uptime: health.uptime,
        components: health.components,
        timestamp: new Date().toISOString()
      });
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
          timestamp: new Date().toISOString()
        }
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
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('[MONITORING-SERVER] SIGINT received, shutting down gracefully...');
      await reconciliationService.stop();
      await ammMonitor.stop();
      process.exit(0);
    });

  } catch (error) {
    logger.error('[MONITORING-SERVER] Fatal error:', error);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  logger.error('[MONITORING-SERVER] Unhandled error:', error);
  process.exit(1);
});
