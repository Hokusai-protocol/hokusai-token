/**
 * API types for contract deployment endpoints
 */

export interface DeployTokenRequest {
  /** JWT authentication token */
  token: string;
  /** Model ID to deploy token for */
  modelId: string;
  /** User's Ethereum address */
  userAddress: string;
  /** Custom token name (optional, defaults to model name) */
  tokenName?: string;
  /** Custom token symbol (optional, auto-generated if not provided) */
  tokenSymbol?: string;
  /** Initial token supply (defaults to 0 for minting on demand) */
  initialSupply?: string;
  /** Optional metadata for the token */
  metadata?: {
    description?: string;
    website?: string;
    whitepaper?: string;
    tags?: Record<string, string>;
  };
}

export interface DeployTokenResponse {
  /** Unique deployment request ID */
  requestId: string;
  /** Current deployment status */
  status: 'pending' | 'processing' | 'deployed' | 'failed';
  /** Estimated completion time in seconds */
  estimatedCompletionTime?: number;
  /** Message describing current status */
  message: string;
  /** Token details (available when status is 'deployed') */
  tokenDetails?: {
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    transactionHash: string;
    registryTransactionHash: string;
    blockNumber: number;
    deploymentTime: string;
  };
  /** Links for further actions */
  links: {
    status: string;
    cancel?: string;
  };
}

export interface DeploymentStatusResponse {
  /** Deployment request ID */
  requestId: string;
  /** Current deployment status */
  status: 'pending' | 'processing' | 'deployed' | 'failed';
  /** Progress percentage (0-100) */
  progress: number;
  /** Current step description */
  currentStep: string;
  /** Timestamp of last status update */
  lastUpdated: string;
  /** Token details (available when status is 'deployed') */
  tokenDetails?: {
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    transactionHash: string;
    registryTransactionHash: string;
    blockNumber: number;
    gasUsed: string;
    gasPrice: string;
    deploymentTime: string;
    network: string;
  };
  /** Error details (available when status is 'failed') */
  error?: DeploymentError;
  /** Estimated completion time for pending/processing deployments */
  estimatedCompletion?: string;
}

export interface DeploymentError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Detailed error description */
  details?: string;
  /** Suggestions for resolving the error */
  suggestions?: string[];
  /** Timestamp when error occurred */
  timestamp: string;
  /** Whether the deployment can be retried */
  retryable: boolean;
  /** Technical error details (only in development) */
  technical?: {
    stack?: string;
    originalError?: string;
  };
}

export interface DeploymentListResponse {
  /** Array of deployment status objects */
  deployments: DeploymentStatusResponse[];
  /** Pagination metadata */
  pagination: {
    total: number;
    page: number;
    limit: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

export interface CancelDeploymentResponse {
  /** Whether the cancellation was successful */
  success: boolean;
  /** Status message */
  message: string;
  /** Updated deployment status */
  status: DeploymentStatusResponse;
}

export interface AuthenticatedUser {
  /** User ID from JWT token */
  userId: string;
  /** User's Ethereum address */
  address: string;
  /** User's email */
  email?: string;
  /** Token expiration timestamp */
  exp: number;
}

export interface ApiResponse<T = unknown> {
  /** Whether the request was successful */
  success: boolean;
  /** Response data */
  data?: T;
  /** Error information */
  error?: {
    code: string;
    message: string;
    details?: string;
  };
  /** Request metadata */
  meta?: {
    requestId: string;
    timestamp: string;
    version: string;
  };
}

export type DeployTokenApiResponse = ApiResponse<DeployTokenResponse>;
export type DeploymentStatusApiResponse = ApiResponse<DeploymentStatusResponse>;
export type DeploymentListApiResponse = ApiResponse<DeploymentListResponse>;
export type CancelDeploymentApiResponse = ApiResponse<CancelDeploymentResponse>;