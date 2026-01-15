/**
 * AMM Monitoring Example
 *
 * Demonstrates how to use the AMM monitoring system
 *
 * Usage:
 *   npx tsx src/examples/amm-monitoring-example.ts
 */

import * as dotenv from 'dotenv';
import { AMMMonitor } from '../monitoring';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

async function main() {
  logger.info('Starting AMM Monitoring Example...\n');

  // Create monitor (loads config from environment)
  const monitor = new AMMMonitor();

  // Register alert callback
  monitor.onAlert(async (alert) => {
    logger.info(`📧 Would send email alert: ${alert.message}`);
    // In production, this would send email via AWS SES
  });

  try {
    // Start monitoring
    await monitor.start();

    // Log metrics every 30 seconds
    const metricsInterval = setInterval(() => {
      const metricsData = monitor.getMetrics();
      const systemMetrics = metricsData.systemMetrics;

      logger.info('\n' + '='.repeat(70));
      logger.info('System Metrics Update');
      logger.info('='.repeat(70));
      logger.info(`Total TVL:         $${systemMetrics.totalTVL.toLocaleString()}`);
      logger.info(`24h Volume:        $${systemMetrics.totalVolume24h.toLocaleString()}`);
      logger.info(`24h Trades:        ${systemMetrics.totalTrades24h}`);
      logger.info(`Active Pools:      ${systemMetrics.totalPoolCount}`);
      logger.info(`Unique Traders:    ${systemMetrics.totalUniqueTraders24h} (24h)`);
      logger.info('='.repeat(70) + '\n');
    }, 30000);

    // Log health every minute
    const healthInterval = setInterval(() => {
      const health = monitor.getHealth();

      logger.info('\n' + '='.repeat(70));
      logger.info('Health Check');
      logger.info('='.repeat(70));
      logger.info(`Status:            ${health.status.toUpperCase()}`);
      logger.info(`Uptime:            ${(health.uptime / 1000 / 60).toFixed(1)} minutes`);
      logger.info(`Pools Monitored:   ${health.poolsMonitored}`);
      logger.info('Components:');
      logger.info(`  Pool Discovery:  ${health.componentsStatus.poolDiscovery ? '✅' : '❌'}`);
      logger.info(`  State Tracking:  ${health.componentsStatus.stateTracking ? '✅' : '❌'}`);
      logger.info(`  Event Listening: ${health.componentsStatus.eventListening ? '✅' : '❌'}`);
      logger.info(`  Metrics:         ${health.componentsStatus.metricsCollection ? '✅' : '❌'}`);

      if (health.errors && health.errors.length > 0) {
        logger.warn('Recent Errors:');
        health.errors.forEach(err => logger.warn(`  • ${err}`));
      }

      logger.info('='.repeat(70) + '\n');
    }, 60000);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('\n\nReceived SIGINT, shutting down gracefully...');
      clearInterval(metricsInterval);
      clearInterval(healthInterval);
      await monitor.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('\n\nReceived SIGTERM, shutting down gracefully...');
      clearInterval(metricsInterval);
      clearInterval(healthInterval);
      await monitor.stop();
      process.exit(0);
    });

    // Keep running
    logger.info('Monitoring running... Press Ctrl+C to stop\n');

  } catch (error) {
    logger.error('Failed to start monitoring:', error);
    process.exit(1);
  }
}

main();
