import { Router, Request, Response } from 'express';
import { AMMMonitor } from '../monitoring/amm-monitor';

export function monitoringRouter(ammMonitor: AMMMonitor): Router {
  const router = Router();

  /**
   * GET /api/monitoring/health
   * Health check for monitoring system
   */
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const health = await ammMonitor.getHealth();
      res.json({
        success: true,
        data: health,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'MONITORING_HEALTH_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/metrics
   * Get current metrics for all pools
   */
  router.get('/metrics', async (_req: Request, res: Response) => {
    try {
      const metrics = await ammMonitor.getMetrics();
      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'METRICS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/pools
   * List all discovered pools
   */
  router.get('/pools', (_req: Request, res: Response) => {
    try {
      const pools = ammMonitor.getDiscoveredPools();
      res.json({
        success: true,
        data: {
          pools,
          count: pools.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'POOLS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/pools/:poolAddress/state
   * Get current state for a specific pool
   */
  router.get('/pools/:poolAddress/state', (req: Request, res: Response) => {
    try {
      const { poolAddress } = req.params;
      const state = ammMonitor.getPoolState(poolAddress);

      if (!state) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'POOL_NOT_FOUND',
            message: `Pool ${poolAddress} not found or not being tracked`,
            timestamp: new Date().toISOString()
          }
        });
      }

      res.json({
        success: true,
        data: state,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'POOL_STATE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/pools/:poolAddress/history
   * Get state history for a specific pool
   */
  router.get('/pools/:poolAddress/history', (req: Request, res: Response) => {
    try {
      const { poolAddress } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

      const history = ammMonitor.getPoolStateHistory(poolAddress, limit);

      if (!history || history.length === 0) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'POOL_NOT_FOUND',
            message: `Pool ${poolAddress} not found or has no history`,
            timestamp: new Date().toISOString()
          }
        });
      }

      res.json({
        success: true,
        data: {
          poolAddress,
          history,
          count: history.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'POOL_HISTORY_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/alerts/recent
   * Get recent alerts (last 24 hours)
   */
  router.get('/alerts/recent', (_req: Request, res: Response) => {
    try {
      const alerts = ammMonitor.getRecentAlerts();
      res.json({
        success: true,
        data: {
          alerts,
          count: alerts.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'ALERTS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/events/recent
   * Get recent trade and security events
   */
  router.get('/events/recent', (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const type = req.query.type as string | undefined;

      const events = ammMonitor.getRecentEvents(limit, type);

      res.json({
        success: true,
        data: {
          events,
          count: events.length,
          filters: {
            limit,
            type: type || 'all'
          }
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'EVENTS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/alerts/stats
   * Get alert manager statistics
   */
  router.get('/alerts/stats', (_req: Request, res: Response) => {
    try {
      const stats = ammMonitor.getAlertStats();
      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'ALERT_STATS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/monitoring/summary
   * Get system-wide summary metrics
   */
  router.get('/summary', async (_req: Request, res: Response) => {
    try {
      const metrics = await ammMonitor.getMetrics();
      const pools = ammMonitor.getDiscoveredPools();
      const health = await ammMonitor.getHealth();
      const recentAlerts = ammMonitor.getRecentAlerts();
      const alertStats = ammMonitor.getAlertStats();

      const summary = {
        pools: {
          total: pools.length,
          list: pools.map(p => ({
            address: p.ammAddress,
            modelId: p.modelId,
            name: p.name
          }))
        },
        systemMetrics: metrics.systemMetrics,
        health: {
          status: health.isHealthy ? 'healthy' : 'unhealthy',
          uptime: health.uptime,
          components: health.components
        },
        alerts: {
          last24h: recentAlerts.length,
          critical: recentAlerts.filter(a => a.priority === 'critical').length,
          high: recentAlerts.filter(a => a.priority === 'high').length,
          medium: recentAlerts.filter(a => a.priority === 'medium').length,
          stats: alertStats
        }
      };

      res.json({
        success: true,
        data: summary,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'SUMMARY_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  return router;
}
