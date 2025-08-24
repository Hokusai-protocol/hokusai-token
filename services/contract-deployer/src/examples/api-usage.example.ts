/**
 * Example usage of the API types, schemas, and error handling
 */

import {
  DeployTokenRequest,
  DeployTokenResponse,
  DeploymentStatusResponse,
  ApiResponse
} from '../types/api.types';

import { ValidationHelpers } from '../schemas/api-schemas';
import { ApiErrorFactory, ApiError, ERROR_CODES } from '../types/errors';

/**
 * Example: Validating a deploy token request
 */
function validateDeployRequest(requestData: unknown): DeployTokenRequest {
  const validation = ValidationHelpers.validateDeployTokenRequest(requestData);
  
  if (validation.error) {
    const errorResponse = ValidationHelpers.createValidationErrorResponse(validation.error);
    throw new ApiError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Request validation failed',
      type: 'validation' as any,
      severity: 'low' as any,
      statusCode: 400,
      retryable: false,
      details: JSON.stringify(errorResponse.error.details),
      correlationId: 'example-123'
    });
  }
  
  return validation.value!;
}

/**
 * Example: Creating a successful API response
 */
function createSuccessResponse<T>(data: T, requestId: string): ApiResponse<T> {
  return {
    success: true,
    data,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
      version: '1.0'
    }
  };
}

/**
 * Example: Creating an error response
 */
function createErrorResponse(error: ApiError, requestId: string): ApiResponse {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
      version: '1.0'
    }
  };
}

/**
 * Example: Deploy token endpoint handler
 */
async function deployTokenHandler(requestData: unknown, requestId: string): Promise<ApiResponse<DeployTokenResponse>> {
  try {
    // Validate request
    const validRequest = validateDeployRequest(requestData);
    
    // Simulate token deployment logic
    const response: DeployTokenResponse = {
      requestId,
      status: 'pending',
      estimatedCompletionTime: 300, // 5 minutes
      message: 'Token deployment request received and queued for processing',
      links: {
        status: `/api/deployments/${requestId}`,
        cancel: `/api/deployments/${requestId}/cancel`
      }
    };
    
    return createSuccessResponse(response, requestId);
    
  } catch (error) {
    if (error instanceof ApiError) {
      return createErrorResponse(error, requestId);
    }
    
    // Handle unexpected errors
    const apiError = ApiErrorFactory.internalError(
      'Unexpected error during deployment',
      error as Error,
      requestId
    );
    
    return createErrorResponse(apiError, requestId);
  }
}

/**
 * Example: Deployment status endpoint handler
 */
async function getDeploymentStatusHandler(requestId: string): Promise<ApiResponse<DeploymentStatusResponse>> {
  try {
    // Validate request ID format
    const validation = ValidationHelpers.validateDeploymentStatusQuery({ requestId });
    
    if (validation.error) {
      throw ApiErrorFactory.validationError(validation.error.message, requestId);
    }
    
    // Simulate fetching deployment status
    const statusResponse: DeploymentStatusResponse = {
      requestId,
      status: 'processing',
      progress: 75,
      currentStep: 'Deploying token contract to blockchain',
      lastUpdated: new Date().toISOString(),
      estimatedCompletion: new Date(Date.now() + 60000).toISOString() // 1 minute from now
    };
    
    return createSuccessResponse(statusResponse, requestId);
    
  } catch (error) {
    if (error instanceof ApiError) {
      return createErrorResponse(error, requestId);
    }
    
    const apiError = ApiErrorFactory.internalError(
      'Error fetching deployment status',
      error as Error,
      requestId
    );
    
    return createErrorResponse(apiError, requestId);
  }
}

/**
 * Example: Error handling scenarios
 */
function demonstrateErrorHandling(): void {
  console.log('=== Error Handling Examples ===');
  
  // Authentication error
  const authError = ApiErrorFactory.invalidToken('Token signature is invalid', 'req-123');
  console.log('Auth Error:', authError.toApiResponse());
  
  // Validation error
  const validationError = ApiErrorFactory.validationError('Model ID is required', 'req-124');
  console.log('Validation Error:', validationError.toApiResponse());
  
  // Business logic error
  const businessError = ApiErrorFactory.tokenAlreadyExists('model-123', 'req-125');
  console.log('Business Error:', businessError.toApiResponse());
  
  // System error
  const systemError = ApiErrorFactory.serviceUnavailable('blockchain', 'req-126');
  console.log('System Error:', systemError.toApiResponse());
}

/**
 * Example: Validation helpers usage
 */
function demonstrateValidation(): void {
  console.log('=== Validation Examples ===');
  
  // Valid Ethereum address
  console.log('Valid ETH address:', ValidationHelpers.isValidEthereumAddress('0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9'));
  
  // Valid token symbol
  console.log('Valid token symbol:', ValidationHelpers.isValidTokenSymbol('HOKUSAI'));
  
  // Valid model ID
  console.log('Valid model ID:', ValidationHelpers.isValidModelId('sentiment-analysis-v1'));
  
  // Invalid examples
  console.log('Invalid ETH address:', ValidationHelpers.isValidEthereumAddress('invalid-address'));
  console.log('Invalid token symbol:', ValidationHelpers.isValidTokenSymbol('too-long-symbol-name'));
}

// Export examples for testing
export {
  validateDeployRequest,
  createSuccessResponse,
  createErrorResponse,
  deployTokenHandler,
  getDeploymentStatusHandler,
  demonstrateErrorHandling,
  demonstrateValidation
};