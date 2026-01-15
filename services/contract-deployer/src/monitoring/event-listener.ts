import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import { PoolConfig, AlertThresholds } from '../config/monitoring-config';

/**
 * Event Listener
 *
 * Listens for critical events from AMM pools and related contracts:
 * - Buy/Sell events (trading activity)
 * - FeesDeposited events (fee tracking)
 * - Paused/Unpaused events (security)
 * - OwnershipTransferred events (security)
 * - ParametersUpdated events (governance)
 * - TokensMinted/TokensBurned events (token operations)
 */

export interface TradeEvent {
  type: 'buy' | 'sell';
  poolAddress: string;
  modelId: string;
  trader: string;
  reserveAmount: bigint;      // USDC in/out (6 decimals)
  tokenAmount: bigint;         // Tokens out/in (18 decimals)
  feeAmount: bigint;           // Fee collected (6 decimals USDC)
  spotPrice: bigint;           // Price after trade (6 decimals)
  reserveAmountUSD: number;    // Formatted USD amount
  tokenAmountFormatted: number; // Formatted token amount
  feeAmountUSD: number;        // Formatted fee in USD
  spotPriceUSD: number;        // Formatted spot price
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
}

export interface SecurityEvent {
  type: 'paused' | 'unpaused' | 'ownership_transferred' | 'parameters_updated' | 'role_granted' | 'role_revoked';
  poolAddress?: string;
  contractAddress: string;
  modelId?: string;
  actor: string;               // Who triggered the event
  details: Record<string, any>;
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
}

export interface FeeEvent {
  poolAddress: string;
  modelId: string;
  depositor: string;
  amount: bigint;              // USDC deposited (6 decimals)
  amountUSD: number;           // Formatted USD
  newReserveBalance: bigint;
  newSpotPrice: bigint;
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
}

export interface EventAlert {
  type: 'whale_trade' | 'security_event' | 'fee_mismatch';
  priority: 'critical' | 'high' | 'medium';
  message: string;
  event: TradeEvent | SecurityEvent | FeeEvent;
  metadata?: Record<string, any>;
}

export interface EventListenerCallbacks {
  onTradeEvent?: (event: TradeEvent) => Promise<void>;
  onSecurityEvent?: (event: SecurityEvent) => Promise<void>;
  onFeeEvent?: (event: FeeEvent) => Promise<void>;
  onAlert?: (alert: EventAlert) => Promise<void>;
}

export class EventListener {
  private provider: ethers.Provider;
  private thresholds: AlertThresholds;
  private callbacks: EventListenerCallbacks;

  private poolContracts: Map<string, ethers.Contract> = new Map();
  private isListening: boolean = false;

  // AMM Pool ABI - Events
  private static readonly POOL_ABI = [
    'event Buy(address indexed buyer, uint256 reserveIn, uint256 tokensOut, uint256 fee, uint256 spotPrice)',
    'event Sell(address indexed seller, uint256 tokensIn, uint256 reserveOut, uint256 fee, uint256 spotPrice)',
    'event FeesDeposited(address indexed depositor, uint256 amount, uint256 newReserveBalance, uint256 newSpotPrice)',
    'event Paused(address account)',
    'event Unpaused(address account)',
    'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
    'event ParametersUpdated(uint256 newCrr, uint256 newTradeFee, uint16 newProtocolFee)',
    'function modelId() view returns (string)'
  ];

  // TokenManager ABI - Events
  private static readonly TOKEN_MANAGER_ABI = [
    'event TokensMinted(string indexed modelId, address indexed recipient, uint256 amount)',
    'event TokensBurned(string indexed modelId, address indexed account, uint256 amount)',
    'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
    'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)'
  ];

  constructor(
    provider: ethers.Provider,
    thresholds: AlertThresholds,
    callbacks: EventListenerCallbacks = {}
  ) {
    this.provider = provider;
    this.thresholds = thresholds;
    this.callbacks = callbacks;
  }

  /**
   * Start listening to events for a pool
   */
  async startListeningToPool(poolConfig: PoolConfig): Promise<void> {
    const { ammAddress, modelId } = poolConfig;

    if (this.poolContracts.has(ammAddress)) {
      logger.warn(`Already listening to pool ${modelId} at ${ammAddress}`);
      return;
    }

    logger.info(`Starting event listener for ${modelId} (${ammAddress})`);

    const pool = new ethers.Contract(ammAddress, EventListener.POOL_ABI, this.provider);
    this.poolContracts.set(ammAddress, pool);

    // Listen for Buy events
    pool.on('Buy', async (buyer, reserveIn, tokensOut, fee, spotPrice, event) => {
      await this.handleBuyEvent(poolConfig, {
        buyer,
        reserveIn,
        tokensOut,
        fee,
        spotPrice,
        event
      });
    });

    // Listen for Sell events
    pool.on('Sell', async (seller, tokensIn, reserveOut, fee, spotPrice, event) => {
      await this.handleSellEvent(poolConfig, {
        seller,
        tokensIn,
        reserveOut,
        fee,
        spotPrice,
        event
      });
    });

    // Listen for FeesDeposited events
    pool.on('FeesDeposited', async (depositor, amount, newReserveBalance, newSpotPrice, event) => {
      await this.handleFeesDepositedEvent(poolConfig, {
        depositor,
        amount,
        newReserveBalance,
        newSpotPrice,
        event
      });
    });

    // Listen for Paused events
    pool.on('Paused', async (account, event) => {
      await this.handlePausedEvent(poolConfig, account, event, true);
    });

    // Listen for Unpaused events
    pool.on('Unpaused', async (account, event) => {
      await this.handlePausedEvent(poolConfig, account, event, false);
    });

    // Listen for OwnershipTransferred events
    pool.on('OwnershipTransferred', async (previousOwner, newOwner, event) => {
      await this.handleOwnershipTransferredEvent(poolConfig, previousOwner, newOwner, event);
    });

    // Listen for ParametersUpdated events
    pool.on('ParametersUpdated', async (newCrr, newTradeFee, newProtocolFee, event) => {
      await this.handleParametersUpdatedEvent(poolConfig, {
        newCrr,
        newTradeFee,
        newProtocolFee,
        event
      });
    });

    this.isListening = true;
    logger.info(`Event listener started for ${modelId}`);
  }

  /**
   * Stop listening to events for a pool
   */
  stopListeningToPool(poolAddress: string): void {
    const pool = this.poolContracts.get(poolAddress);
    if (pool) {
      pool.removeAllListeners();
      this.poolContracts.delete(poolAddress);
      logger.info(`Stopped listening to pool ${poolAddress}`);
    }
  }

  /**
   * Stop listening to all pools
   */
  stopAllListening(): void {
    for (const [poolAddress, pool] of this.poolContracts) {
      pool.removeAllListeners();
      logger.info(`Stopped listening to pool ${poolAddress}`);
    }
    this.poolContracts.clear();
    this.isListening = false;
    logger.info('All event listeners stopped');
  }

  /**
   * Handle Buy event
   */
  private async handleBuyEvent(poolConfig: PoolConfig, data: {
    buyer: string;
    reserveIn: bigint;
    tokensOut: bigint;
    fee: bigint;
    spotPrice: bigint;
    event: ethers.EventLog;
  }): Promise<void> {
    const { buyer, reserveIn, tokensOut, fee, spotPrice, event } = data;

    const tradeEvent: TradeEvent = {
      type: 'buy',
      poolAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      trader: buyer,
      reserveAmount: reserveIn,
      tokenAmount: tokensOut,
      feeAmount: fee,
      spotPrice,
      reserveAmountUSD: Number(ethers.formatUnits(reserveIn, 6)),
      tokenAmountFormatted: Number(ethers.formatEther(tokensOut)),
      feeAmountUSD: Number(ethers.formatUnits(fee, 6)),
      spotPriceUSD: Number(ethers.formatUnits(spotPrice, 6)),
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: Math.floor(Date.now() / 1000)
    };

    logger.info(`🟢 BUY: ${tradeEvent.modelId} - $${tradeEvent.reserveAmountUSD.toFixed(2)} → ${tradeEvent.tokenAmountFormatted.toFixed(2)} tokens`);
    logger.debug(`   Trader: ${buyer}, Fee: $${tradeEvent.feeAmountUSD.toFixed(2)}, New Price: $${tradeEvent.spotPriceUSD.toFixed(6)}`);

    // Check for whale trade
    if (tradeEvent.reserveAmountUSD > this.thresholds.largeTradeUSD) {
      const alert: EventAlert = {
        type: 'whale_trade',
        priority: 'high',
        message: `🐋 Large BUY: $${tradeEvent.reserveAmountUSD.toFixed(2)} on ${tradeEvent.modelId}`,
        event: tradeEvent,
        metadata: {
          tradeUSD: tradeEvent.reserveAmountUSD,
          threshold: this.thresholds.largeTradeUSD
        }
      };

      if (this.callbacks.onAlert) {
        await this.callbacks.onAlert(alert);
      }
    }

    // Notify callback
    if (this.callbacks.onTradeEvent) {
      await this.callbacks.onTradeEvent(tradeEvent);
    }
  }

  /**
   * Handle Sell event
   */
  private async handleSellEvent(poolConfig: PoolConfig, data: {
    seller: string;
    tokensIn: bigint;
    reserveOut: bigint;
    fee: bigint;
    spotPrice: bigint;
    event: ethers.EventLog;
  }): Promise<void> {
    const { seller, tokensIn, reserveOut, fee, spotPrice, event } = data;

    const tradeEvent: TradeEvent = {
      type: 'sell',
      poolAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      trader: seller,
      reserveAmount: reserveOut,
      tokenAmount: tokensIn,
      feeAmount: fee,
      spotPrice,
      reserveAmountUSD: Number(ethers.formatUnits(reserveOut, 6)),
      tokenAmountFormatted: Number(ethers.formatEther(tokensIn)),
      feeAmountUSD: Number(ethers.formatUnits(fee, 6)),
      spotPriceUSD: Number(ethers.formatUnits(spotPrice, 6)),
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: Math.floor(Date.now() / 1000)
    };

    logger.info(`🔴 SELL: ${tradeEvent.modelId} - ${tradeEvent.tokenAmountFormatted.toFixed(2)} tokens → $${tradeEvent.reserveAmountUSD.toFixed(2)}`);
    logger.debug(`   Trader: ${seller}, Fee: $${tradeEvent.feeAmountUSD.toFixed(2)}, New Price: $${tradeEvent.spotPriceUSD.toFixed(6)}`);

    // Check for whale trade
    if (tradeEvent.reserveAmountUSD > this.thresholds.largeTradeUSD) {
      const alert: EventAlert = {
        type: 'whale_trade',
        priority: 'high',
        message: `🐋 Large SELL: $${tradeEvent.reserveAmountUSD.toFixed(2)} on ${tradeEvent.modelId}`,
        event: tradeEvent,
        metadata: {
          tradeUSD: tradeEvent.reserveAmountUSD,
          threshold: this.thresholds.largeTradeUSD
        }
      };

      if (this.callbacks.onAlert) {
        await this.callbacks.onAlert(alert);
      }
    }

    // Notify callback
    if (this.callbacks.onTradeEvent) {
      await this.callbacks.onTradeEvent(tradeEvent);
    }
  }

  /**
   * Handle FeesDeposited event
   */
  private async handleFeesDepositedEvent(poolConfig: PoolConfig, data: {
    depositor: string;
    amount: bigint;
    newReserveBalance: bigint;
    newSpotPrice: bigint;
    event: ethers.EventLog;
  }): Promise<void> {
    const { depositor, amount, newReserveBalance, newSpotPrice, event } = data;

    const feeEvent: FeeEvent = {
      poolAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      depositor,
      amount,
      amountUSD: Number(ethers.formatUnits(amount, 6)),
      newReserveBalance,
      newSpotPrice,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: Math.floor(Date.now() / 1000)
    };

    logger.info(`💰 FEES DEPOSITED: ${feeEvent.modelId} - $${feeEvent.amountUSD.toFixed(2)}`);
    logger.debug(`   Depositor: ${depositor}, New Reserve: $${Number(ethers.formatUnits(newReserveBalance, 6)).toFixed(2)}`);

    // Notify callback
    if (this.callbacks.onFeeEvent) {
      await this.callbacks.onFeeEvent(feeEvent);
    }
  }

  /**
   * Handle Paused/Unpaused events
   */
  private async handlePausedEvent(
    poolConfig: PoolConfig,
    account: string,
    event: ethers.EventLog,
    isPaused: boolean
  ): Promise<void> {
    const securityEvent: SecurityEvent = {
      type: isPaused ? 'paused' : 'unpaused',
      poolAddress: poolConfig.ammAddress,
      contractAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      actor: account,
      details: { paused: isPaused },
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: Math.floor(Date.now() / 1000)
    };

    logger.warn(`🚨 ${isPaused ? 'PAUSED' : 'UNPAUSED'}: ${poolConfig.modelId} by ${account}`);
    logger.warn(`   Tx: ${event.transactionHash}`);

    // Always alert on pause/unpause
    const alert: EventAlert = {
      type: 'security_event',
      priority: 'critical',
      message: `🚨 ${isPaused ? 'PAUSED' : 'UNPAUSED'}: ${poolConfig.modelId} by ${account}`,
      event: securityEvent
    };

    if (this.callbacks.onAlert) {
      await this.callbacks.onAlert(alert);
    }

    // Notify callback
    if (this.callbacks.onSecurityEvent) {
      await this.callbacks.onSecurityEvent(securityEvent);
    }
  }

  /**
   * Handle OwnershipTransferred event
   */
  private async handleOwnershipTransferredEvent(
    poolConfig: PoolConfig,
    previousOwner: string,
    newOwner: string,
    event: ethers.EventLog
  ): Promise<void> {
    const securityEvent: SecurityEvent = {
      type: 'ownership_transferred',
      poolAddress: poolConfig.ammAddress,
      contractAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      actor: newOwner,
      details: { previousOwner, newOwner },
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: Math.floor(Date.now() / 1000)
    };

    logger.warn(`🚨 OWNERSHIP TRANSFERRED: ${poolConfig.modelId}`);
    logger.warn(`   From: ${previousOwner} → To: ${newOwner}`);
    logger.warn(`   Tx: ${event.transactionHash}`);

    // Always alert on ownership transfer
    const alert: EventAlert = {
      type: 'security_event',
      priority: 'critical',
      message: `🚨 OWNERSHIP TRANSFERRED: ${poolConfig.modelId} from ${previousOwner} to ${newOwner}`,
      event: securityEvent
    };

    if (this.callbacks.onAlert) {
      await this.callbacks.onAlert(alert);
    }

    // Notify callback
    if (this.callbacks.onSecurityEvent) {
      await this.callbacks.onSecurityEvent(securityEvent);
    }
  }

  /**
   * Handle ParametersUpdated event
   */
  private async handleParametersUpdatedEvent(poolConfig: PoolConfig, data: {
    newCrr: bigint;
    newTradeFee: bigint;
    newProtocolFee: number;
    event: ethers.EventLog;
  }): Promise<void> {
    const { newCrr, newTradeFee, newProtocolFee, event } = data;

    const securityEvent: SecurityEvent = {
      type: 'parameters_updated',
      poolAddress: poolConfig.ammAddress,
      contractAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      actor: event.transactionHash, // We don't have actor address from event
      details: {
        oldCrr: poolConfig.crr,
        newCrr: Number(newCrr),
        oldTradeFee: poolConfig.tradeFee,
        newTradeFee: Number(newTradeFee),
        oldProtocolFee: poolConfig.protocolFee,
        newProtocolFee
      },
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: Math.floor(Date.now() / 1000)
    };

    logger.warn(`⚙️  PARAMETERS UPDATED: ${poolConfig.modelId}`);
    logger.warn(`   CRR: ${poolConfig.crr / 10000}% → ${Number(newCrr) / 10000}%`);
    logger.warn(`   Trade Fee: ${poolConfig.tradeFee / 100}% → ${Number(newTradeFee) / 100}%`);
    logger.warn(`   Protocol Fee: ${poolConfig.protocolFee / 100}% → ${newProtocolFee / 100}%`);

    // Alert on parameter changes
    const alert: EventAlert = {
      type: 'security_event',
      priority: 'high',
      message: `⚙️  PARAMETERS UPDATED: ${poolConfig.modelId}`,
      event: securityEvent
    };

    if (this.callbacks.onAlert) {
      await this.callbacks.onAlert(alert);
    }

    // Notify callback
    if (this.callbacks.onSecurityEvent) {
      await this.callbacks.onSecurityEvent(securityEvent);
    }
  }

  /**
   * Get listening status
   */
  isListeningToPool(poolAddress: string): boolean {
    return this.poolContracts.has(poolAddress);
  }

  /**
   * Get number of pools being listened to
   */
  getListeningPoolCount(): number {
    return this.poolContracts.size;
  }
}
