import * as Joi from 'joi';
import { DeployTokenRequest } from '../types/api.types';

// Validation patterns
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TOKEN_SYMBOL_REGEX = /^[A-Z0-9\-]{1,10}$/;
const TOKEN_NAME_REGEX = /^[a-zA-Z0-9\s\-_]{1,50}$/;
const JWT_REGEX = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const MODEL_ID_REGEX = /^[a-zA-Z0-9\-_]{1,64}$/;
const DECIMAL_STRING_REGEX = /^\d+(\.\d+)?$/;

/**
 * Joi schema for validating deploy token requests
 */
export const deployTokenRequestSchema = Joi.object<DeployTokenRequest>({
  token: Joi.string()
    .pattern(JWT_REGEX)
    .required()
    .messages({
      'string.pattern.base': 'Invalid JWT token format',
      'any.required': 'Authentication token is required'
    }),
    
  modelId: Joi.string()
    .pattern(MODEL_ID_REGEX)
    .required()
    .messages({
      'string.pattern.base': 'Model ID must contain only alphanumeric characters, hyphens, and underscores (1-64 characters)',
      'any.required': 'Model ID is required'
    }),
    
  userAddress: Joi.string()
    .pattern(ETH_ADDRESS_REGEX)
    .required()
    .messages({
      'string.pattern.base': 'Invalid Ethereum address format',
      'any.required': 'User address is required'
    }),
    
  tokenName: Joi.string()
    .pattern(TOKEN_NAME_REGEX)
    .optional()
    .messages({
      'string.pattern.base': 'Token name must be 1-50 characters containing only letters, numbers, spaces, hyphens, and underscores'
    }),
    
  tokenSymbol: Joi.string()
    .pattern(TOKEN_SYMBOL_REGEX)
    .optional()
    .messages({
      'string.pattern.base': 'Token symbol must be 1-10 uppercase characters, numbers, or hyphens'
    }),
    
  initialSupply: Joi.string()
    .pattern(DECIMAL_STRING_REGEX)
    .optional()
    .messages({
      'string.pattern.base': 'Initial supply must be a valid decimal number as string'
    }),
    
  metadata: Joi.object({
    description: Joi.string().max(500).optional(),
    website: Joi.string().uri().optional(),
    whitepaper: Joi.string().uri().optional(),
    tags: Joi.object().pattern(Joi.string(), Joi.string()).optional()
  }).optional()
});

/**
 * Joi schema for query parameters in deployment status requests
 */
export const deploymentStatusQuerySchema = Joi.object({
  requestId: Joi.string()
    .guid({ version: 'uuidv4' })
    .required()
    .messages({
      'string.guid': 'Request ID must be a valid UUID',
      'any.required': 'Request ID is required'
    })
});

/**
 * Joi schema for deployment list query parameters
 */
export const deploymentListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('pending', 'processing', 'deployed', 'failed').optional(),
  modelId: Joi.string().pattern(MODEL_ID_REGEX).optional(),
  userAddress: Joi.string().pattern(ETH_ADDRESS_REGEX).optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().min(Joi.ref('startDate')).optional()
});

/**
 * Joi schema for cancel deployment request
 */
export const cancelDeploymentSchema = Joi.object({
  requestId: Joi.string()
    .guid({ version: 'uuidv4' })
    .required()
    .messages({
      'string.guid': 'Request ID must be a valid UUID',
      'any.required': 'Request ID is required'
    }),
  reason: Joi.string().max(200).optional()
});

/**
 * Joi schema for JWT token validation
 */
export const jwtTokenSchema = Joi.object({
  userId: Joi.string().required(),
  address: Joi.string().pattern(ETH_ADDRESS_REGEX).required(),
  email: Joi.string().email().optional(),
  exp: Joi.number().integer().positive().required(),
  iat: Joi.number().integer().positive().optional(),
  iss: Joi.string().optional()
});

/**
 * Validation helper functions
 */
export class ValidationHelpers {
  /**
   * Validates a deploy token request
   */
  static validateDeployTokenRequest(data: unknown): Joi.ValidationResult<DeployTokenRequest> {
    return deployTokenRequestSchema.validate(data, {
      abortEarly: false,
      stripUnknown: true
    });
  }

  /**
   * Validates deployment status query parameters
   */
  static validateDeploymentStatusQuery(data: unknown): Joi.ValidationResult<{ requestId: string }> {
    return deploymentStatusQuerySchema.validate(data, {
      abortEarly: false,
      stripUnknown: true
    });
  }

  /**
   * Validates deployment list query parameters
   */
  static validateDeploymentListQuery(data: unknown): Joi.ValidationResult<{
    page: number;
    limit: number;
    status?: string;
    modelId?: string;
    userAddress?: string;
    startDate?: Date;
    endDate?: Date;
  }> {
    return deploymentListQuerySchema.validate(data, {
      abortEarly: false,
      stripUnknown: true
    });
  }

  /**
   * Validates cancel deployment request
   */
  static validateCancelDeployment(data: unknown): Joi.ValidationResult<{
    requestId: string;
    reason?: string;
  }> {
    return cancelDeploymentSchema.validate(data, {
      abortEarly: false,
      stripUnknown: true
    });
  }

  /**
   * Validates JWT token payload
   */
  static validateJWTPayload(data: unknown): Joi.ValidationResult<{
    userId: string;
    address: string;
    email?: string;
    exp: number;
    iat?: number;
    iss?: string;
  }> {
    return jwtTokenSchema.validate(data, {
      abortEarly: false,
      stripUnknown: true
    });
  }

  /**
   * Validates Ethereum address
   */
  static isValidEthereumAddress(address: string): boolean {
    return ETH_ADDRESS_REGEX.test(address);
  }

  /**
   * Validates token symbol format
   */
  static isValidTokenSymbol(symbol: string): boolean {
    return TOKEN_SYMBOL_REGEX.test(symbol);
  }

  /**
   * Validates token name format
   */
  static isValidTokenName(name: string): boolean {
    return TOKEN_NAME_REGEX.test(name);
  }

  /**
   * Validates model ID format
   */
  static isValidModelId(modelId: string): boolean {
    return MODEL_ID_REGEX.test(modelId);
  }

  /**
   * Validates decimal string (for token amounts)
   */
  static isValidDecimalString(value: string): boolean {
    return DECIMAL_STRING_REGEX.test(value);
  }

  /**
   * Creates standardized validation error response
   */
  static createValidationErrorResponse(error: Joi.ValidationError) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message,
          value: detail.context?.value
        }))
      }
    };
  }
}