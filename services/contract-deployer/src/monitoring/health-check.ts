import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { logger } from '../utils/logger';

export interface HealthCheckConfig {
  redis: RedisClientType;
  provider: ethers.Provider;
  registryAddress: string;
  tokenManagerAddress: string;
}

export interface ComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  error?: string;
  warnings?: string[];
}

export interface DeploymentMetrics {
  messagesProcessed: number;
  messagesFaile: number;
  tokensDeployed: number;
  averageDeploymentTime: number;
  lastDeploymentTime: string;
  totalGasUsed?: string;
  failureReasons?: Record<string, number>;
}

export class HealthCheckService {
  private config: HealthCheckConfig;
  private startTime: Date = new Date();
  private metrics: {
    messagesProcessed: number;
    messagesFailed: number;
    tokensDeployed: number;
    totalDeploymentTime: number;
    lastDeploymentTime?: Date;
    totalGasUsed: bigint;
    failureReasons: Map<string, number>;
    queueDepths: Map<string, number[]>;
  } = {
    messagesProcessed: 0,
    messagesFailed: 0,
    tokensDeployed: 0,
    totalDeploymentTime: 0,
    totalGasUsed: 0n,
    failureReasons: new Map(),
    queueDepths: new Map()
  };
  private alertHandlers: ((alert: any) => void)[] = [];

  constructor(config: HealthCheckConfig) {
    this.config = config;
  }

  getHealthHandler() {
    return async (_req: Request, res: Response) => {
      try {
        const isHealthy = await this.checkBasicHealth();
        const status = isHealthy ? 200 : 503;
        
        res.status(status).json({
          status: isHealthy ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          uptime: Date.now() - this.startTime.getTime()
        });
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: 'Health check failed'
        });
      }
    };
  }

  getDetailedHealthHandler() {
    return async (_req: Request, res: Response) => {
      try {
        const health = await this.getDetailedHealth();
        const status = health.status === 'healthy' ? 200 : 503;
        
        res.status(status).json(health);
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: 'Detailed health check failed'
        });
      }
    };
  }

  private async checkBasicHealth(): Promise<boolean> {
    try {
      // Check Redis
      await this.config.redis.ping();
      
      // Check blockchain
      await this.config.provider.getBlockNumber();
      
      return true;
    } catch (error) {
      logger.error('Basic health check failed', { error });
      return false;
    }
  }

  private async getDetailedHealth(): Promise<any> {
    const redisHealth = await this.checkRedisHealth();
    const blockchainHealth = await this.checkBlockchainHealth();
    const contractsHealth = await this.checkContractsHealth();
    
    const overallStatus = this.calculateOverallStatus([
      redisHealth.status,
      blockchainHealth.status,
      contractsHealth.registry.status,
      contractsHealth.tokenManager.status
    ]);

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime.getTime(),
      components: {
        redis: redisHealth,
        blockchain: blockchainHealth,
        contracts: contractsHealth
      },
      metrics: this.getMetrics()
    };
  }

  private async checkRedisHealth(): Promise<any> {
    const startTime = Date.now();
    
    try {
      await this.config.redis.ping();
      const latency = Date.now() - startTime;
      
      // Get queue depths
      const [inbound, processing, deadLetter, outbound] = await Promise.all([
        this.config.redis.lLen('hokusai:model_ready_queue'),
        this.config.redis.lLen('hokusai:processing_queue'),
        this.config.redis.lLen('hokusai:dlq'),
        this.config.redis.lLen('hokusai:token_deployed_queue')
      ]);
      
      const queues = { inbound, processing, deadLetter, outbound };
      
      // Check for degraded state
      let status: ComponentHealth['status'] = 'healthy';
      if (inbound > 100 || processing > 50 || deadLetter > 10) {
        status = 'degraded';
      }
      
      return {
        status,
        latency,
        queues
      };
    } catch (error: any) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  private async checkBlockchainHealth(): Promise<any> {
    const startTime = Date.now();
    
    try {
      const [network, blockNumber] = await Promise.all([
        this.config.provider.getNetwork(),
        this.config.provider.getBlockNumber()
      ]);
      
      // For health check, we don't have a signer, so use a dummy address
      const deployerAddress = '0x0000000000000000000000000000000000000000';
      
      const balance = await this.config.provider.getBalance(deployerAddress);
      const latency = Date.now() - startTime;
      
      const warnings: string[] = [];
      
      // Check for low balance (less than 0.1 ETH/MATIC)
      if (balance < ethers.parseEther('0.1')) {
        warnings.push('Low deployer balance');
      }
      
      return {
        status: warnings.length > 0 ? 'degraded' : 'healthy',
        network: network.name,
        chainId: Number(network.chainId),
        blockNumber,
        latency,
        deployerBalance: balance.toString(),
        ...(warnings.length > 0 && { warnings })
      };
    } catch (error: any) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  private async checkContractsHealth(): Promise<any> {
    const checkContract = async (address: string, _name: string) => {
      try {
        const code = await this.config.provider.getCode(address);
        return {
          status: code !== '0x' ? 'healthy' : 'unhealthy',
          address
        };
      } catch (error) {
        return {
          status: 'unhealthy',
          address,
          error: 'Failed to check contract'
        };
      }
    };

    const [registry, tokenManager] = await Promise.all([
      checkContract(this.config.registryAddress, 'ModelRegistry'),
      checkContract(this.config.tokenManagerAddress, 'TokenManager')
    ]);

    return {
      registry,
      tokenManager
    };
  }

  private calculateOverallStatus(statuses: ComponentHealth['status'][]): ComponentHealth['status'] {
    if (statuses.includes('unhealthy')) return 'unhealthy';
    if (statuses.includes('degraded')) return 'degraded';
    return 'healthy';
  }

  recordDeployment(data: {
    modelId: string;
    tokenAddress: string;
    deploymentTime: number;
    gasUsed: string;
  }): void {
    this.metrics.messagesProcessed++;
    this.metrics.tokensDeployed++;
    this.metrics.totalDeploymentTime += data.deploymentTime;
    this.metrics.lastDeploymentTime = new Date();
    this.metrics.totalGasUsed += BigInt(data.gasUsed);
  }

  recordFailure(data: {
    modelId: string;
    error: string;
    stage: string;
  }): void {
    this.metrics.messagesFailed++;
    
    const count = this.metrics.failureReasons.get(data.error) || 0;
    this.metrics.failureReasons.set(data.error, count + 1);
    
    // Check for high failure rate
    if (this.metrics.messagesFailed >= 5) {
      this.triggerAlert({
        type: 'high_failure_rate',
        failures: this.metrics.messagesFailed,
        window: '5m'
      });
    }
  }

  recordQueueDepth(queue: string, depth: number): void {
    if (!this.metrics.queueDepths.has(queue)) {
      this.metrics.queueDepths.set(queue, []);
    }
    
    const depths = this.metrics.queueDepths.get(queue)!;
    depths.push(depth);
    
    // Keep only last 100 measurements
    if (depths.length > 100) {
      depths.shift();
    }
    
    // Check for high queue depth
    const threshold = queue === 'inbound' ? 100 : 50;
    if (depth > threshold) {
      this.triggerAlert({
        type: 'queue_depth_high',
        queue,
        depth,
        threshold
      });
    }
  }

  getMetrics(): DeploymentMetrics {
    const avgDeploymentTime = this.metrics.tokensDeployed > 0
      ? this.metrics.totalDeploymentTime / this.metrics.tokensDeployed
      : 0;

    const failureReasons: Record<string, number> = {};
    this.metrics.failureReasons.forEach((count, reason) => {
      failureReasons[reason] = count;
    });

    return {
      messagesProcessed: this.metrics.messagesProcessed,
      messagesFaile: this.metrics.messagesFailed,
      tokensDeployed: this.metrics.tokensDeployed,
      averageDeploymentTime: avgDeploymentTime,
      lastDeploymentTime: this.metrics.lastDeploymentTime?.toISOString() || 'never',
      totalGasUsed: this.metrics.totalGasUsed.toString(),
      failureReasons
    };
  }

  async isReady(): Promise<boolean> {
    try {
      // Check Redis
      await this.config.redis.ping();
      
      // Check blockchain
      await this.config.provider.getNetwork();
      
      // Check contracts deployed
      const [registryCode, managerCode] = await Promise.all([
        this.config.provider.getCode(this.config.registryAddress),
        this.config.provider.getCode(this.config.tokenManagerAddress)
      ]);
      
      return registryCode !== '0x' && managerCode !== '0x';
    } catch (error) {
      return false;
    }
  }

  onAlert(handler: (alert: any) => void): void {
    this.alertHandlers.push(handler);
  }

  private triggerAlert(alert: any): void {
    this.alertHandlers.forEach(handler => {
      try {
        handler(alert);
      } catch (error) {
        logger.error('Alert handler failed', { error, alert });
      }
    });
  }
}