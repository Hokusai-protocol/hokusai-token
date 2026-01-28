import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import { PoolConfig } from '../config/monitoring-config';

/**
 * Pool Discovery Service
 *
 * Automatically discovers AMM pools by:
 * 1. Loading initial pools from deployment artifact
 * 2. Listening for PoolCreated events from HokusaiAMMFactory
 * 3. Querying factory for all existing pools
 *
 * New pools are automatically added to monitoring.
 */

export interface PoolDiscoveredCallback {
  (pool: PoolConfig): Promise<void>;
}

export class PoolDiscovery {
  private provider: ethers.Provider;
  private factoryAddress: string;
  private factoryContract: ethers.Contract;
  private discoveredPools: Map<string, PoolConfig> = new Map(); // poolAddress -> PoolConfig
  private callbacks: PoolDiscoveredCallback[] = [];
  private isListening: boolean = false;

  // Factory ABI (just the events and functions we need)
  private static readonly FACTORY_ABI = [
    'event PoolCreated(string indexed modelId, address indexed poolAddress, address indexed tokenAddress, uint256 crr, uint256 tradeFee, uint16 protocolFeeBps, uint256 ibrDuration)',
    'function getPoolByModelId(string modelId) view returns (address)',
    'function getAllPools() view returns (address[])'
  ];

  constructor(provider: ethers.Provider, factoryAddress: string) {
    this.provider = provider;
    this.factoryAddress = factoryAddress;
    this.factoryContract = new ethers.Contract(
      factoryAddress,
      PoolDiscovery.FACTORY_ABI,
      provider
    );
  }

  /**
   * Register a callback to be notified when new pools are discovered
   */
  onPoolDiscovered(callback: PoolDiscoveredCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Add initial pools from deployment artifact
   */
  async addInitialPools(pools: PoolConfig[]): Promise<void> {
    logger.info(`Adding ${pools.length} initial pools to monitoring`);

    for (const pool of pools) {
      if (this.discoveredPools.has(pool.ammAddress)) {
        logger.warn(`Pool ${pool.ammAddress} already discovered, skipping`);
        continue;
      }

      this.discoveredPools.set(pool.ammAddress, pool);
      logger.info(`Initial pool added: ${pool.modelId} at ${pool.ammAddress}`);

      // Notify callbacks
      await this.notifyCallbacks(pool);
    }

    logger.info(`Initial pool discovery complete: ${this.discoveredPools.size} pools`);
  }

  /**
   * Query factory for all existing pools
   * Useful for discovering pools created before monitoring started
   */
  async discoverExistingPools(): Promise<void> {
    try {
      logger.info('Querying factory for existing pools...');

      // Check if factory has getAllPools function
      const code = await this.provider.getCode(this.factoryAddress);
      if (code === '0x') {
        throw new Error('Factory contract not found at address');
      }

      // Try to get all pools from factory
      try {
        const getAllPools = this.factoryContract.getAllPools;
        if (!getAllPools) {
          throw new Error('getAllPools method not found on factory contract');
        }
        const poolAddresses = await getAllPools();
        logger.info(`Factory reports ${poolAddresses.length} existing pools`);

        for (const poolAddress of poolAddresses) {
          if (this.discoveredPools.has(poolAddress)) {
            continue; // Already discovered
          }

          // Get pool details
          const poolConfig = await this.getPoolConfig(poolAddress);
          if (poolConfig) {
            this.discoveredPools.set(poolAddress, poolConfig);
            logger.info(`Existing pool discovered: ${poolConfig.modelId} at ${poolAddress}`);
            await this.notifyCallbacks(poolConfig);
          }
        }
      } catch (error) {
        logger.warn('Factory.getAllPools() not available, will rely on events only');
      }

    } catch (error) {
      logger.error('Failed to discover existing pools:', error);
    }
  }

  /**
   * Start listening for PoolCreated events
   */
  async startListening(fromBlock: number | 'latest' = 'latest'): Promise<void> {
    if (this.isListening) {
      logger.warn('Pool discovery already listening');
      return;
    }

    logger.info(`Starting pool discovery listener from block: ${fromBlock}`);

    try {
      // Listen for PoolCreated events
      this.factoryContract.on('PoolCreated', async (
        modelId: string,
        poolAddress: string,
        tokenAddress: string,
        crr: bigint,
        tradeFee: bigint,
        protocolFeeBps: number,
        ibrDuration: bigint,
        event: ethers.EventLog
      ) => {
        await this.handlePoolCreated({
          modelId,
          poolAddress,
          tokenAddress,
          crr: Number(crr),
          tradeFee: Number(tradeFee),
          protocolFeeBps,
          ibrDuration: Number(ibrDuration),
          event
        });
      });

      this.isListening = true;
      logger.info('Pool discovery listener started');

      // Also query for historical events if not starting from latest
      if (fromBlock !== 'latest') {
        await this.queryHistoricalPoolCreatedEvents(fromBlock);
      }

    } catch (error) {
      logger.error('Failed to start pool discovery listener:', error);
      throw error;
    }
  }

  /**
   * Stop listening for PoolCreated events
   */
  async stopListening(): Promise<void> {
    if (!this.isListening) {
      return;
    }

    logger.info('Stopping pool discovery listener');
    this.factoryContract.removeAllListeners('PoolCreated');
    this.isListening = false;
    logger.info('Pool discovery listener stopped');
  }

  /**
   * Query historical PoolCreated events
   */
  private async queryHistoricalPoolCreatedEvents(fromBlock: number): Promise<void> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      logger.info(`Querying historical PoolCreated events from block ${fromBlock} to ${currentBlock}`);

      const filters = this.factoryContract.filters;
      if (!filters || !filters.PoolCreated) {
        throw new Error('PoolCreated filter not found on factory contract');
      }
      const filter = filters.PoolCreated();
      const events = await this.factoryContract.queryFilter(filter, fromBlock, currentBlock);

      logger.info(`Found ${events.length} historical PoolCreated events`);

      for (const event of events) {
        if (event instanceof ethers.EventLog) {
          const { modelId, poolAddress, tokenAddress, crr, tradeFee, protocolFeeBps, ibrDuration } = event.args;
          await this.handlePoolCreated({
            modelId,
            poolAddress,
            tokenAddress,
            crr: Number(crr),
            tradeFee: Number(tradeFee),
            protocolFeeBps: Number(protocolFeeBps),
            ibrDuration: Number(ibrDuration),
            event
          });
        }
      }

    } catch (error) {
      logger.error('Failed to query historical PoolCreated events:', error);
    }
  }

  /**
   * Handle PoolCreated event
   */
  private async handlePoolCreated(data: {
    modelId: string;
    poolAddress: string;
    tokenAddress: string;
    crr: number;
    tradeFee: number;
    protocolFeeBps: number;
    ibrDuration: number;
    event: ethers.EventLog;
  }): Promise<void> {
    const { modelId, poolAddress, tokenAddress, crr, tradeFee, protocolFeeBps, ibrDuration, event } = data;

    // Check if already discovered
    if (this.discoveredPools.has(poolAddress)) {
      logger.debug(`Pool ${poolAddress} already discovered, ignoring duplicate event`);
      return;
    }

    logger.info(`🏊 New pool discovered: ${modelId} at ${poolAddress}`);
    logger.info(`   Token: ${tokenAddress}`);
    logger.info(`   CRR: ${crr / 10000}%`);
    logger.info(`   Trade Fee: ${tradeFee / 100}%`);
    logger.info(`   Protocol Fee: ${protocolFeeBps / 100}%`);
    logger.info(`   IBR Duration: ${ibrDuration / 86400} days`);
    logger.info(`   Block: ${event.blockNumber}, Tx: ${event.transactionHash}`);

    // Calculate IBR end time
    const block = await event.getBlock();
    const ibrEndsAt = new Date((block.timestamp + ibrDuration) * 1000).toISOString();

    // Fetch phase parameters from pool contract
    const pool = new ethers.Contract(poolAddress, [
      'function FLAT_CURVE_THRESHOLD() view returns (uint256)',
      'function FLAT_CURVE_PRICE() view returns (uint256)'
    ], this.provider);

    const thresholdFn = pool.FLAT_CURVE_THRESHOLD;
    const priceFn = pool.FLAT_CURVE_PRICE;

    if (!thresholdFn || !priceFn) {
      throw new Error('Phase parameter methods not found on pool contract');
    }

    const flatCurveThreshold = await thresholdFn();
    const flatCurvePrice = await priceFn();

    logger.info(`   Flat Curve Threshold: ${ethers.formatUnits(flatCurveThreshold, 6)} USDC`);
    logger.info(`   Flat Curve Price: $${ethers.formatUnits(flatCurvePrice, 6)}`);

    // Create pool config
    const poolConfig: PoolConfig = {
      modelId,
      tokenAddress,
      ammAddress: poolAddress,
      crr,
      tradeFee,
      protocolFee: protocolFeeBps,
      ibrDuration,
      ibrEndsAt,
      flatCurveThreshold: flatCurveThreshold.toString(),
      flatCurvePrice: flatCurvePrice.toString()
    };

    // Store pool
    this.discoveredPools.set(poolAddress, poolConfig);

    // Notify callbacks
    await this.notifyCallbacks(poolConfig);

    logger.info(`✅ Pool ${modelId} added to monitoring (${this.discoveredPools.size} total pools)`);
  }

  /**
   * Get pool configuration by querying the pool contract
   */
  private async getPoolConfig(poolAddress: string): Promise<PoolConfig | null> {
    try {
      const poolAbi = [
        'function modelId() view returns (string)',
        'function hokusaiToken() view returns (address)',
        'function crr() view returns (uint256)',
        'function tradeFee() view returns (uint256)',
        'function protocolFeeBps() view returns (uint16)',
        'function buyOnlyUntil() view returns (uint256)',
        'function FLAT_CURVE_THRESHOLD() view returns (uint256)',
        'function FLAT_CURVE_PRICE() view returns (uint256)'
      ];

      const pool = new ethers.Contract(poolAddress, poolAbi, this.provider);

      // Safely call contract methods with null checks
      const modelIdFn = pool.modelId;
      const tokenFn = pool.hokusaiToken;
      const crrFn = pool.crr;
      const tradeFeeFn = pool.tradeFee;
      const protocolFeeFn = pool.protocolFeeBps;
      const ibrFn = pool.buyOnlyUntil;

      if (!modelIdFn || !tokenFn || !crrFn || !tradeFeeFn || !protocolFeeFn || !ibrFn) {
        throw new Error('Pool contract methods not found');
      }

      const thresholdFn = pool.FLAT_CURVE_THRESHOLD;
      const priceFn = pool.FLAT_CURVE_PRICE;

      if (!thresholdFn || !priceFn) {
        throw new Error('Phase parameter methods not found');
      }

      const [modelId, tokenAddress, crr, tradeFee, protocolFeeBps, buyOnlyUntil, flatCurveThreshold, flatCurvePrice] = await Promise.all([
        modelIdFn(),
        tokenFn(),
        crrFn(),
        tradeFeeFn(),
        protocolFeeFn(),
        ibrFn(),
        thresholdFn(),
        priceFn()
      ]);

      const currentTime = Math.floor(Date.now() / 1000);
      const ibrDuration = Number(buyOnlyUntil) > currentTime ? Number(buyOnlyUntil) - currentTime : 0;
      const ibrEndsAt = new Date(Number(buyOnlyUntil) * 1000).toISOString();

      return {
        modelId,
        tokenAddress,
        ammAddress: poolAddress,
        crr: Number(crr),
        tradeFee: Number(tradeFee),
        protocolFee: Number(protocolFeeBps),
        ibrDuration,
        ibrEndsAt,
        flatCurveThreshold: flatCurveThreshold.toString(),
        flatCurvePrice: flatCurvePrice.toString()
      };

    } catch (error) {
      logger.error(`Failed to get pool config for ${poolAddress}:`, error);
      return null;
    }
  }

  /**
   * Notify all registered callbacks about a new pool
   */
  private async notifyCallbacks(pool: PoolConfig): Promise<void> {
    for (const callback of this.callbacks) {
      try {
        await callback(pool);
      } catch (error) {
        logger.error(`Pool discovery callback failed for ${pool.modelId}:`, error);
      }
    }
  }

  /**
   * Get all discovered pools
   */
  getDiscoveredPools(): PoolConfig[] {
    return Array.from(this.discoveredPools.values());
  }

  /**
   * Get pool by address
   */
  getPool(poolAddress: string): PoolConfig | undefined {
    return this.discoveredPools.get(poolAddress);
  }

  /**
   * Get pool count
   */
  getPoolCount(): number {
    return this.discoveredPools.size;
  }

  /**
   * Check if pool is discovered
   */
  hasPool(poolAddress: string): boolean {
    return this.discoveredPools.has(poolAddress);
  }
}
