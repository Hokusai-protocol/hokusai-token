import { Request, Response, NextFunction } from 'express';
import { AuthenticatedUser } from '../types/api.types';
import { ApiErrorFactory } from '../types/errors';
import { ValidationHelpers } from '../schemas/api-schemas';
import { createLogger } from '../utils/logger';

const logger = createLogger('auth');

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      correlationId?: string;
    }
  }
}

/**
 * Simple API key authentication middleware (temporary solution)
 * TODO: Replace with proper JWT authentication
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const apiKey = req.headers['x-api-key'] as string;
    const authHeader = req.headers.authorization;
    
    // Generate correlation ID for request tracking
    req.correlationId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // For now, accept either API key or Bearer token
    let token: string | undefined;
    
    if (apiKey) {
      token = apiKey;
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    
    if (!token) {
      logger.warn('Authentication failed: No token provided', {
        correlationId: req.correlationId,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      const error = ApiErrorFactory.invalidToken(
        'Authentication token is required',
        req.correlationId
      );
      return res.status(error.statusCode).json({
        success: false,
        error: error.toApiResponse()
      });
    }
    
    // For API key auth (temporary)
    if (apiKey) {
      const validApiKeys = process.env.VALID_API_KEYS?.split(',') || [];
      
      if (!validApiKeys.includes(token)) {
        logger.warn('Authentication failed: Invalid API key', {
          correlationId: req.correlationId,
          ip: req.ip
        });
        
        const error = ApiErrorFactory.invalidToken(
          'Invalid API key',
          req.correlationId
        );
        return res.status(error.statusCode).json({
          success: false,
          error: error.toApiResponse()
        });
      }
      
      // Create a mock user for API key auth
      req.user = {
        userId: 'api_user',
        address: '0x0000000000000000000000000000000000000000', // Will be overridden by userAddress in request
        exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
      };
      
      logger.info('API key authentication successful', {
        correlationId: req.correlationId,
        userId: req.user.userId
      });
      
      return next();
    }
    
    // For JWT auth (future implementation)
    try {
      // TODO: Implement proper JWT validation
      // const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      // const validation = ValidationHelpers.validateJWTPayload(decoded);
      
      // For now, assume valid JWT structure
      const mockJwtPayload = {
        userId: 'jwt_user',
        address: '0x0000000000000000000000000000000000000000',
        exp: Math.floor(Date.now() / 1000) + 3600
      };
      
      const validation = ValidationHelpers.validateJWTPayload(mockJwtPayload);
      
      if (validation.error) {
        logger.warn('JWT validation failed', {
          correlationId: req.correlationId,
          errors: validation.error.details
        });
        
        const error = ApiErrorFactory.invalidToken(
          'Invalid token format',
          req.correlationId
        );
        return res.status(error.statusCode).json({
          success: false,
          error: error.toApiResponse()
        });
      }
      
      const payload = validation.value!;
      
      // Check if token is expired
      if (payload.exp <= Math.floor(Date.now() / 1000)) {
        logger.warn('JWT token expired', {
          correlationId: req.correlationId,
          exp: payload.exp,
          now: Math.floor(Date.now() / 1000)
        });
        
        const error = ApiErrorFactory.tokenExpired(req.correlationId);
        return res.status(error.statusCode).json({
          success: false,
          error: error.toApiResponse()
        });
      }
      
      req.user = {
        userId: payload.userId,
        address: payload.address,
        email: payload.email,
        exp: payload.exp
      };
      
      logger.info('JWT authentication successful', {
        correlationId: req.correlationId,
        userId: req.user.userId
      });
      
      next();
      
    } catch (jwtError) {
      logger.warn('JWT verification failed', {
        correlationId: req.correlationId,
        error: jwtError
      });
      
      const error = ApiErrorFactory.invalidToken(
        'Token verification failed',
        req.correlationId
      );
      return res.status(error.statusCode).json({
        success: false,
        error: error.toApiResponse()
      });
    }
    
  } catch (error) {
    logger.error('Authentication middleware error', {
      correlationId: req.correlationId,
      error
    });
    
    const apiError = ApiErrorFactory.internalError(
      'Authentication system error',
      error instanceof Error ? error : undefined,
      req.correlationId
    );
    
    return res.status(apiError.statusCode).json({
      success: false,
      error: apiError.toApiResponse()
    });
  }
}

/**
 * Middleware to validate that user has permission to access a specific resource
 */
export function requireOwnership(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    const error = ApiErrorFactory.unauthorized(req.correlationId);
    return res.status(error.statusCode).json({
      success: false,
      error: error.toApiResponse()
    });
  }
  
  // For now, all authenticated users can access all resources
  // TODO: Implement proper resource ownership validation
  next();
}

/**
 * Middleware to extract user address from request body and validate against token
 */
export function validateUserAddress(req: Request, res: Response, next: NextFunction): void {
  const userAddress = req.body?.userAddress;
  
  if (!userAddress) {
    const error = ApiErrorFactory.validationError(
      'userAddress is required in request body',
      req.correlationId
    );
    return res.status(error.statusCode).json({
      success: false,
      error: error.toApiResponse()
    });
  }
  
  if (!ValidationHelpers.isValidEthereumAddress(userAddress)) {
    const error = ApiErrorFactory.validationError(
      'Invalid Ethereum address format',
      req.correlationId
    );
    return res.status(error.statusCode).json({
      success: false,
      error: error.toApiResponse()
    });
  }
  
  // For API key auth, allow any valid address
  // For JWT auth, validate that address matches token
  if (req.user?.address !== '0x0000000000000000000000000000000000000000') {
    if (req.user?.address.toLowerCase() !== userAddress.toLowerCase()) {
      logger.warn('Address mismatch in request', {
        correlationId: req.correlationId,
        tokenAddress: req.user?.address,
        requestAddress: userAddress
      });
      
      const error = ApiErrorFactory.unauthorized(req.correlationId);
      return res.status(error.statusCode).json({
        success: false,
        error: error.toApiResponse()
      });
    }
  }
  
  next();
}