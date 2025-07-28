export interface DeploymentRequest {
  id: string;
  modelId: string;
  tokenName: string;
  tokenSymbol: string;
  initialSupply: string;
  metadata?: {
    description?: string;
    website?: string;
    whitepaper?: string;
  };
  timestamp: number;
  retryCount?: number;
}

export interface DeploymentResult {
  requestId: string;
  tokenAddress: string;
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  deploymentTime: number;
}

export interface DeploymentStatus {
  requestId: string;
  status: 'pending' | 'processing' | 'deployed' | 'failed';
  tokenAddress?: string;
  transactionHash?: string;
  error?: string;
  timestamp: number;
}

export interface QueueMessage {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
  attempts: number;
}