import { Router, Request, Response, NextFunction } from 'express';
import { QueueService } from '../services/queue.service';
import { BlockchainService } from '../services/blockchain.service';
import { DeploymentService } from '../services/deployment.service';
import { apiKeyAuth, validateUserAddress } from '../middleware/auth';
import { ValidationHelpers } from '../schemas/api-schemas';
import { ApiErrorFactory, toApiError } from '../types/errors';
import { DeployTokenRequest } from '../types/api.types';
import { createLogger } from '../utils/logger';

const logger = createLogger('deployment-routes');

export function deploymentRouter(
  queueService: QueueService,
  blockchainService: BlockchainService,
  deploymentService: DeploymentService,
): Router {
  const router = Router();

  // Apply authentication to all routes
  router.use(apiKeyAuth);

  /**
   * POST /api/deployments
   * Create a new token deployment
   */
  router.post('/', validateUserAddress, async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info('Deployment request received', {
        correlationId: req.correlationId,
        userId: req.user?.userId,
        userAddress: req.body?.userAddress,
        modelId: req.body?.modelId
      });

      // Validate request body
      const validation = ValidationHelpers.validateDeployTokenRequest(req.body);
      
      if (validation.error) {
        logger.warn('Deployment request validation failed', {
          correlationId: req.correlationId,
          errors: validation.error.details
        });

        const errorResponse = ValidationHelpers.createValidationErrorResponse(validation.error);
        return res.status(400).json(errorResponse);
      }

      const deployRequest = validation.value as DeployTokenRequest;

      // Ensure user is authenticated
      if (!req.user) {
        const error = ApiErrorFactory.unauthorized(req.correlationId);
        return res.status(error.statusCode).json({
          success: false,
          error: error.toApiResponse()
        });
      }

      // Create deployment
      const deploymentResponse = await deploymentService.createDeployment(
        deployRequest,
        req.user,
        req.correlationId
      );

      logger.info('Deployment created successfully', {
        correlationId: req.correlationId,
        requestId: deploymentResponse.requestId,
        status: deploymentResponse.status
      });

      res.status(202).json({
        success: true,
        data: deploymentResponse,
        meta: {
          requestId: req.correlationId || 'unknown',
          timestamp: new Date().toISOString(),
          version: '1.0'
        }
      });

    } catch (error) {
      logger.error('Deployment creation failed', {
        correlationId: req.correlationId,
        error
      });

      const apiError = toApiError(error, req.correlationId);
      res.status(apiError.statusCode).json({
        success: false,
        error: apiError.toApiResponse()
      });
    }
  });

  /**
   * GET /api/deployments/:id/status
   * Get deployment status
   */
  router.get('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deploymentId = req.params.id;

      logger.info('Deployment status request received', {
        correlationId: req.correlationId,
        deploymentId,
        userId: req.user?.userId
      });

      // Validate deployment ID format
      if (!deploymentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deploymentId)) {
        const error = ApiErrorFactory.validationError(
          'Invalid deployment ID format. Must be a valid UUID.',
          req.correlationId
        );
        return res.status(error.statusCode).json({
          success: false,
          error: error.toApiResponse()
        });
      }

      // Get deployment status
      const status = await deploymentService.getDeploymentStatus(
        deploymentId,
        req.correlationId
      );

      logger.info('Deployment status retrieved', {
        correlationId: req.correlationId,
        deploymentId,
        status: status.status
      });

      res.status(200).json({
        success: true,
        data: status,
        meta: {
          requestId: req.correlationId || 'unknown',
          timestamp: new Date().toISOString(),
          version: '1.0'
        }
      });

    } catch (error) {
      logger.error('Failed to get deployment status', {
        correlationId: req.correlationId,
        deploymentId: req.params.id,
        error
      });

      const apiError = toApiError(error, req.correlationId);
      res.status(apiError.statusCode).json({
        success: false,
        error: apiError.toApiResponse()
      });
    }
  });

  /**
   * GET /api/deployments/:id
   * Legacy endpoint - redirects to status endpoint
   */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info('Legacy deployment endpoint accessed', {
        correlationId: req.correlationId,
        deploymentId: req.params.id
      });

      // Redirect to status endpoint
      const statusUrl = `/api/deployments/${req.params.id}/status`;
      res.redirect(301, statusUrl);

    } catch (error) {
      logger.error('Legacy endpoint redirect failed', {
        correlationId: req.correlationId,
        error
      });

      const apiError = toApiError(error, req.correlationId);
      res.status(apiError.statusCode).json({
        success: false,
        error: apiError.toApiResponse()
      });
    }
  });

  return router;
}