import { Router, Request, Response } from 'express';
import { CostReconciliationService } from '../monitoring/cost-reconciliation-service';

/**
 * Reconciliation API Routes
 *
 * Provides endpoints for:
 * - Variance history and current variance per model
 * - Cost adjustment recommendations
 * - Runway calculations
 * - Cost ingestion (manual CSV/API input)
 * - Service status and health
 */

export function reconciliationRouter(reconciliationService: CostReconciliationService): Router {
  const router = Router();

  /**
   * GET /api/reconciliation/status
   * Get reconciliation service status
   */
  router.get('/status', (_req: Request, res: Response) => {
    try {
      const status = reconciliationService.getStatus();
      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'STATUS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/reconciliation/models
   * List all tracked models
   */
  router.get('/models', (_req: Request, res: Response) => {
    try {
      const models = reconciliationService.getTrackedModels();
      res.json({
        success: true,
        data: {
          models,
          count: models.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'MODELS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/reconciliation/:modelId/variance
   * Get variance data for a specific model
   */
  router.get('/:modelId/variance', (req: Request, res: Response) => {
    try {
      const { modelId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const current = reconciliationService.getCurrentVariance(modelId);
      const history = reconciliationService.getVarianceHistory(modelId, limit);

      if (!current && history.length === 0) {
        res.status(404).json({
          success: false,
          error: {
            code: 'MODEL_NOT_FOUND',
            message: `No variance data for model ${modelId}`,
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      res.json({
        success: true,
        data: {
          modelId,
          current,
          history,
          historyCount: history.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'VARIANCE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/reconciliation/:modelId/recommendations
   * Get cost adjustment recommendations for a model
   */
  router.get('/:modelId/recommendations', (req: Request, res: Response) => {
    try {
      const { modelId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const latest = reconciliationService.getLatestRecommendation(modelId);
      const recommendations = reconciliationService.getRecommendations(modelId, limit);

      if (!latest && recommendations.length === 0) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NO_RECOMMENDATIONS',
            message: `No recommendations for model ${modelId}`,
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      res.json({
        success: true,
        data: {
          modelId,
          latest,
          recommendations,
          count: recommendations.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'RECOMMENDATIONS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/reconciliation/:modelId/costs
   * Get cost history for a model
   */
  router.get('/:modelId/costs', (req: Request, res: Response) => {
    try {
      const { modelId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const costs = reconciliationService.getCostHistory(modelId, limit);

      if (costs.length === 0) {
        res.status(404).json({
          success: false,
          error: {
            code: 'NO_COSTS',
            message: `No cost history for model ${modelId}`,
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      res.json({
        success: true,
        data: {
          modelId,
          costs,
          count: costs.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'COSTS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * POST /api/reconciliation/:modelId/costs
   * Ingest actual costs for a model
   *
   * Body:
   * {
   *   "provider": "AWS",
   *   "amount": 1234.56,
   *   "period": {
   *     "start": "2026-03-01T00:00:00Z",
   *     "end": "2026-03-31T23:59:59Z"
   *   },
   *   "invoiceId": "INV-2026-03",
   *   "metadata": { ... }
   * }
   */
  router.post('/:modelId/costs', async (req: Request, res: Response) => {
    try {
      const { modelId } = req.params;
      const { provider, amount, period, invoiceId, metadata } = req.body;

      // Validate required fields
      if (!provider || !amount || !period) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required fields: provider, amount, period',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      if (!period.start || !period.end) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Period must have start and end dates',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      // Validate amount
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount < 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_AMOUNT',
            message: 'Amount must be a valid positive number',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      // Validate dates
      const startDate = new Date(period.start);
      const endDate = new Date(period.end);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_DATES',
            message: 'Period start and end must be valid dates',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      if (endDate < startDate) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PERIOD',
            message: 'Period end must be after period start',
            timestamp: new Date().toISOString()
          }
        });
        return;
      }

      // Ingest costs
      await reconciliationService.ingestActualCosts({
        modelId,
        provider,
        amount: parsedAmount,
        period: {
          start: startDate,
          end: endDate
        },
        invoiceId,
        metadata
      });

      res.json({
        success: true,
        data: {
          modelId,
          message: 'Costs ingested successfully'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: {
          code: 'INGEST_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  /**
   * GET /api/reconciliation/summary
   * Get summary of all models
   */
  router.get('/summary', (_req: Request, res: Response) => {
    try {
      const models = reconciliationService.getTrackedModels();

      const summary = models.map(modelId => {
        const variance = reconciliationService.getCurrentVariance(modelId);
        const recommendation = reconciliationService.getLatestRecommendation(modelId);
        const costs = reconciliationService.getCostHistory(modelId, 1);

        return {
          modelId,
          variance: variance ? {
            variancePercent: variance.variancePercent,
            actual: variance.actual,
            estimated: variance.estimated
          } : null,
          recommendation: recommendation ? {
            currentEstimate: recommendation.currentEstimate,
            recommendedEstimate: recommendation.recommendedEstimate,
            adjustmentPercent: recommendation.adjustmentPercent
          } : null,
          latestCost: costs.length > 0 ? costs[0] : null
        };
      });

      res.json({
        success: true,
        data: {
          models: summary,
          count: summary.length
        },
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
