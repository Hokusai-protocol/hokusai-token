/**
 * Error codes and types for the contract deployment API
 */

/**
 * Standard error codes for API responses
 */
export const ERROR_CODES = {
  // Authentication errors (4xx)
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',

  // Validation errors (4xx)
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_MODEL_ID: 'INVALID_MODEL_ID',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  INVALID_TOKEN_SYMBOL: 'INVALID_TOKEN_SYMBOL',
  INVALID_TOKEN_NAME: 'INVALID_TOKEN_NAME',
  INVALID_SUPPLY_AMOUNT: 'INVALID_SUPPLY_AMOUNT',

  // Business logic errors (4xx)
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_NOT_READY: 'MODEL_NOT_READY',
  TOKEN_ALREADY_EXISTS: 'TOKEN_ALREADY_EXISTS',
  DEPLOYMENT_NOT_FOUND: 'DEPLOYMENT_NOT_FOUND',
  DEPLOYMENT_NOT_CANCELLABLE: 'DEPLOYMENT_NOT_CANCELLABLE',
  DUPLICATE_DEPLOYMENT: 'DUPLICATE_DEPLOYMENT',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',

  // Rate limiting (4xx)
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  TOO_MANY_DEPLOYMENTS: 'TOO_MANY_DEPLOYMENTS',

  // Blockchain errors (4xx/5xx)
  BLOCKCHAIN_CONNECTION_ERROR: 'BLOCKCHAIN_CONNECTION_ERROR',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  INSUFFICIENT_GAS: 'INSUFFICIENT_GAS',
  GAS_PRICE_TOO_LOW: 'GAS_PRICE_TOO_LOW',
  NONCE_TOO_LOW: 'NONCE_TOO_LOW',
  CONTRACT_DEPLOYMENT_FAILED: 'CONTRACT_DEPLOYMENT_FAILED',
  REGISTRY_UPDATE_FAILED: 'REGISTRY_UPDATE_FAILED',

  // System errors (5xx)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  QUEUE_ERROR: 'QUEUE_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR'
} as const;

/**
 * Error type enumeration
 */
export enum ErrorType {
  AUTHENTICATION = 'authentication',
  VALIDATION = 'validation',
  BUSINESS_LOGIC = 'business_logic',
  RATE_LIMITING = 'rate_limiting',
  BLOCKCHAIN = 'blockchain',
  SYSTEM = 'system'
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

/**
 * Structured error class for API responses
 */
export class ApiError extends Error {
  public readonly code: string;
  public readonly type: ErrorType;
  public readonly severity: ErrorSeverity;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details?: string;
  public readonly suggestions?: string[];
  public readonly timestamp: string;
  public readonly correlationId?: string;
  public readonly originalError?: Error;

  constructor(options: {
    code: string;
    message: string;
    type: ErrorType;
    severity: ErrorSeverity;
    statusCode: number;
    retryable: boolean;
    details?: string;
    suggestions?: string[];
    correlationId?: string;
    cause?: Error;
  }) {
    super(options.message);
    
    this.name = 'ApiError';
    this.code = options.code;
    this.type = options.type;
    this.severity = options.severity;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
    this.details = options.details;
    this.suggestions = options.suggestions;
    this.timestamp = new Date().toISOString();
    this.correlationId = options.correlationId;
    this.originalError = options.cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
  }

  /**
   * Convert error to API response format
   */
  toApiResponse() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      suggestions: this.suggestions,
      timestamp: this.timestamp,
      retryable: this.retryable,
      ...(process.env.NODE_ENV === 'development' && {
        technical: {
          stack: this.stack,
          originalError: this.originalError?.message
        }
      })
    };
  }

  /**
   * Check if error is retryable
   */
  isRetryable(): boolean {
    return this.retryable;
  }

  /**
   * Check if error is a client error (4xx)
   */
  isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }

  /**
   * Check if error is a server error (5xx)
   */
  isServerError(): boolean {
    return this.statusCode >= 500;
  }
}

/**
 * Factory class for creating standardized API errors
 */
export class ApiErrorFactory {
  /**
   * Authentication errors
   */
  static invalidToken(details?: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.INVALID_TOKEN,
      message: 'Invalid authentication token',
      type: ErrorType.AUTHENTICATION,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 401,
      retryable: false,
      details,
      suggestions: ['Please provide a valid JWT token', 'Check if your token has expired'],
      correlationId
    });
  }

  static tokenExpired(correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.TOKEN_EXPIRED,
      message: 'Authentication token has expired',
      type: ErrorType.AUTHENTICATION,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 401,
      retryable: false,
      suggestions: ['Please refresh your authentication token'],
      correlationId
    });
  }

  static unauthorized(correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.UNAUTHORIZED,
      message: 'Unauthorized access',
      type: ErrorType.AUTHENTICATION,
      severity: ErrorSeverity.HIGH,
      statusCode: 403,
      retryable: false,
      suggestions: ['Ensure you have the required permissions'],
      correlationId
    });
  }

  /**
   * Validation errors
   */
  static validationError(details: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Request validation failed',
      type: ErrorType.VALIDATION,
      severity: ErrorSeverity.LOW,
      statusCode: 400,
      retryable: false,
      details,
      suggestions: ['Check the request format and required fields'],
      correlationId
    });
  }

  static invalidModelId(modelId: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.INVALID_MODEL_ID,
      message: 'Invalid model ID format',
      type: ErrorType.VALIDATION,
      severity: ErrorSeverity.LOW,
      statusCode: 400,
      retryable: false,
      details: `Model ID "${modelId}" does not match required format`,
      suggestions: ['Model ID must contain only alphanumeric characters, hyphens, and underscores (1-64 characters)'],
      correlationId
    });
  }

  /**
   * Business logic errors
   */
  static modelNotFound(modelId: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.MODEL_NOT_FOUND,
      message: 'Model not found',
      type: ErrorType.BUSINESS_LOGIC,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 404,
      retryable: false,
      details: `Model with ID "${modelId}" does not exist`,
      suggestions: ['Verify the model ID is correct', 'Ensure the model has been properly registered'],
      correlationId
    });
  }

  static tokenAlreadyExists(modelId: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.TOKEN_ALREADY_EXISTS,
      message: 'Token already exists for this model',
      type: ErrorType.BUSINESS_LOGIC,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 409,
      retryable: false,
      details: `A token has already been deployed for model "${modelId}"`,
      suggestions: ['Use the existing token', 'Check deployment status'],
      correlationId
    });
  }

  static deploymentNotFound(requestId: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.DEPLOYMENT_NOT_FOUND,
      message: 'Deployment not found',
      type: ErrorType.BUSINESS_LOGIC,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 404,
      retryable: false,
      details: `Deployment with ID "${requestId}" does not exist`,
      suggestions: ['Verify the deployment ID is correct'],
      correlationId
    });
  }

  /**
   * Rate limiting errors
   */
  static rateLimitExceeded(retryAfter: number, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
      message: 'Rate limit exceeded',
      type: ErrorType.RATE_LIMITING,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 429,
      retryable: true,
      details: `Too many requests. Retry after ${retryAfter} seconds`,
      suggestions: [`Wait ${retryAfter} seconds before retrying`],
      correlationId
    });
  }

  /**
   * Blockchain errors
   */
  static blockchainConnectionError(details?: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.BLOCKCHAIN_CONNECTION_ERROR,
      message: 'Blockchain connection error',
      type: ErrorType.BLOCKCHAIN,
      severity: ErrorSeverity.HIGH,
      statusCode: 503,
      retryable: true,
      details,
      suggestions: ['Try again in a few moments', 'Check blockchain network status'],
      correlationId
    });
  }

  static transactionFailed(txHash?: string, reason?: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.TRANSACTION_FAILED,
      message: 'Transaction failed',
      type: ErrorType.BLOCKCHAIN,
      severity: ErrorSeverity.HIGH,
      statusCode: 400,
      retryable: false,
      details: `Transaction ${txHash || 'unknown'} failed: ${reason || 'unknown reason'}`,
      suggestions: ['Check transaction details', 'Ensure sufficient gas and balance'],
      correlationId
    });
  }

  static insufficientGas(correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.INSUFFICIENT_GAS,
      message: 'Insufficient gas for transaction',
      type: ErrorType.BLOCKCHAIN,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 400,
      retryable: true,
      suggestions: ['Increase gas limit', 'Check current gas prices'],
      correlationId
    });
  }

  /**
   * System errors
   */
  static internalError(details?: string, cause?: Error, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal server error',
      type: ErrorType.SYSTEM,
      severity: ErrorSeverity.CRITICAL,
      statusCode: 500,
      retryable: true,
      details,
      suggestions: ['Try again later', 'Contact support if the issue persists'],
      correlationId,
      cause
    });
  }

  static serviceUnavailable(service: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: 'Service temporarily unavailable',
      type: ErrorType.SYSTEM,
      severity: ErrorSeverity.HIGH,
      statusCode: 503,
      retryable: true,
      details: `${service} service is currently unavailable`,
      suggestions: ['Try again in a few moments'],
      correlationId
    });
  }

  static timeoutError(operation: string, correlationId?: string): ApiError {
    return new ApiError({
      code: ERROR_CODES.TIMEOUT_ERROR,
      message: 'Operation timed out',
      type: ErrorType.SYSTEM,
      severity: ErrorSeverity.HIGH,
      statusCode: 504,
      retryable: true,
      details: `${operation} operation exceeded timeout limit`,
      suggestions: ['Try again with a longer timeout', 'Check system load'],
      correlationId
    });
  }
}

/**
 * Type guard to check if an error is an ApiError
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Convert any error to an ApiError
 */
export function toApiError(error: unknown, correlationId?: string): ApiError {
  if (isApiError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return ApiErrorFactory.internalError(error.message, error, correlationId);
  }

  return ApiErrorFactory.internalError(
    typeof error === 'string' ? error : 'Unknown error occurred',
    undefined,
    correlationId
  );
}