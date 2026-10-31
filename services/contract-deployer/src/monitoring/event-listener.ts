import { ethers } from 'ethers';
import { confirmEvent, ConfirmedEvent, ChainEventInput } from './chain-event';
import { IncidentStore } from './incident-store';
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
  reserveAmount: bigint; // USDC in/out (6 decimals)
  tokenAmount: bigint; // Tokens out/in (18 decimals)
  feeAmount: bigint; // Fee collected (6 decimals USDC)
  spotPrice: bigint; // Price after trade (6 decimals)
  reserveAmountUSD: number; // Formatted USD amount
  tokenAmountFormatted: number; // Formatted token amount
  feeAmountUSD: number; // Formatted fee in USD
  spotPriceUSD: number; // Formatted spot price
  blockNumber: number;
  transactionHash: string;
  logIndex?: number;
  blockHash?: string;
  timestamp: number;
}

export interface SecurityEvent {
  type:
    | 'paused'
    | 'unpaused'
    | 'ownership_transferred'
    | 'parameters_updated'
    | 'role_granted'
    | 'role_revoked';
  poolAddress?: string;
  contractAddress: string;
  modelId?: string;
  actor: string; // Who triggered the event
  details: Record<string, any>;
  blockNumber: number;
  transactionHash: string;
  logIndex?: number;
  blockHash?: string;
  timestamp: number;
}

export interface FeeEvent {
  poolAddress: string;
  modelId: string;
  depositor: string;
  amount: bigint; // USDC deposited (6 decimals)
  amountUSD: number; // Formatted USD
  newReserveBalance: bigint;
  newSpotPrice: bigint;
  blockNumber: number;
  transactionHash: string;
  logIndex?: number;
  blockHash?: string;
  timestamp: number;
}

export interface EventAlert {
  type: 'whale_trade' | 'security_event' | 'fee_mismatch';
  priority: 'critical' | 'high' | 'medium' | 'info';
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

export function loadMaintenance(): Array<{ pool: string; actors: string[]; expiresAt: string }> {
  const entries: unknown = JSON.parse(process.env.MONITORING_MAINTENANCE_JSON || '[]');
  if (!Array.isArray(entries)) {
    throw new Error('Maintenance must be an array');
  }
  for (const entry of entries) {
    if (
      !entry ||
      !ethers.isAddress(entry.pool) ||
      !Array.isArray(entry.actors) ||
      !entry.actors.length ||
      !entry.actors.every(
        (actor: unknown) => typeof actor === 'string' && ethers.isAddress(actor),
      ) ||
      !Number.isFinite(Date.parse(entry.expiresAt)) ||
      Date.parse(entry.expiresAt) > Date.now() + 86400_000
    ) {
      throw new Error('Maintenance requires a pool, expected actors and expiry within 24 hours');
    }
  }
  return entries;
}

export class EventListener {
  private maintenance = loadMaintenance();
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
    'event ParametersUpdated(uint256 newCrr, uint256 newTradeFee)',
    'function modelId() view returns (string)',
  ];

  // TokenManager ABI - Events (reserved for future use)
  // private static readonly TOKEN_MANAGER_ABI = [
  //   'event TokensMinted(string indexed modelId, address indexed recipient, uint256 amount)',
  //   'event TokensBurned(string indexed modelId, address indexed account, uint256 amount)',
  //   'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  //   'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)'
  // ];

  constructor(
    provider: ethers.Provider,
    thresholds: AlertThresholds,
    callbacks: EventListenerCallbacks = {},
    private store = new IncidentStore('local'),
    private confirmations = 2,
  ) {
    this.provider = provider;
    this.thresholds = thresholds;
    this.callbacks = callbacks;
  }

  /** Rebind future subscriptions to a replacement provider. */
  setProvider(provider: ethers.Provider): void {
    this.stopAllListening();
    this.provider = provider;
  }

  /**
   * Start listening to events for a pool
   */
  startListeningToPool(poolConfig: PoolConfig): void {
    const { ammAddress, modelId } = poolConfig;

    if (this.poolContracts.has(ammAddress)) {
      logger.warn(`Already listening to pool ${modelId} at ${ammAddress}`);
      return;
    }

    logger.info(`Starting event listener for ${modelId} (${ammAddress})`);

    const pool = new ethers.Contract(ammAddress, EventListener.POOL_ABI, this.provider);
    this.poolContracts.set(ammAddress, pool);

    let queue = Promise.resolve();
    const listen = (
      name: string,
      handler: (args: any[], event: ConfirmedEvent) => Promise<void>,
    ): void => {
      void pool.on(name, (...args: any[]) => {
        const input = args.pop() as ChainEventInput;
        queue = queue
          .then(async () => {
            const event = await confirmEvent(this.provider, input, this.confirmations);
            if (!event) {
              return;
            }
            const key = `event:${event.transactionHash}:${event.index}`;
            if (await this.store.get(key)) {
              return;
            }
            await handler(args, event);
            await this.store.put(key, true, 7 * 86400_000);
          })
          .catch((error) => {
            logger.error(`Failed to process ${name} for ${modelId}`, { error });
          });
      });
    };
    listen('Buy', ([buyer, reserveIn, tokensOut, fee, spotPrice], event) =>
      this.handleBuyEvent(poolConfig, { buyer, reserveIn, tokensOut, fee, spotPrice, event }),
    );
    listen('Sell', ([seller, tokensIn, reserveOut, fee, spotPrice], event) =>
      this.handleSellEvent(poolConfig, { seller, tokensIn, reserveOut, fee, spotPrice, event }),
    );
    listen('FeesDeposited', ([depositor, amount, newReserveBalance, newSpotPrice], event) =>
      this.handleFeesDepositedEvent(poolConfig, {
        depositor,
        amount,
        newReserveBalance,
        newSpotPrice,
        event,
      }),
    );
    listen('Paused', ([account], event) =>
      this.handlePausedEvent(poolConfig, account, event, true),
    );
    listen('Unpaused', ([account], event) =>
      this.handlePausedEvent(poolConfig, account, event, false),
    );
    listen('OwnershipTransferred', ([previousOwner, newOwner], event) =>
      this.handleOwnershipTransferredEvent(poolConfig, previousOwner, newOwner, event),
    );
    listen(
      'ParametersUpdated(uint256,uint256,uint16)',
      ([newCrr, newTradeFee, newProtocolFee], event) =>
        this.handleParametersUpdatedEvent(poolConfig, {
          newCrr,
          newTradeFee,
          newProtocolFee,
          event,
        }),
    );

    listen('ParametersUpdated(uint256,uint256)', ([newCrr, newTradeFee], event) =>
      this.handleParametersUpdatedEvent(poolConfig, {
        newCrr,
        newTradeFee,
        newProtocolFee: 0,
        event,
      }),
    );
    this.isListening = true;
    logger.info(`Event listener started for ${modelId}`);
  }

  /**
   * Stop listening to events for a pool
   */
  stopListeningToPool(poolAddress: string): void {
    const pool = this.poolContracts.get(poolAddress);
    if (pool) {
      void pool.removeAllListeners();
      this.poolContracts.delete(poolAddress);
      logger.info(`Stopped listening to pool ${poolAddress}`);
    }
  }

  /**
   * Stop listening to all pools
   */
  stopAllListening(): void {
    for (const [poolAddress, pool] of this.poolContracts) {
      void pool.removeAllListeners();
      logger.info(`Stopped listening to pool ${poolAddress}`);
    }
    this.poolContracts.clear();
    this.isListening = false;
    logger.info('All event listeners stopped');
  }

  /**
   * Handle Buy event
   */
  private async handleBuyEvent(
    poolConfig: PoolConfig,
    data: {
      buyer: string;
      reserveIn: bigint;
      tokensOut: bigint;
      fee: bigint;
      spotPrice: bigint;
      event: ConfirmedEvent;
    },
  ): Promise<void> {
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
      timestamp: event.timestamp,
      logIndex: event.index,
      blockHash: event.blockHash,
    };

    logger.info(
      `🟢 BUY: ${tradeEvent.modelId} - $${tradeEvent.reserveAmountUSD.toFixed(2)} → ${tradeEvent.tokenAmountFormatted.toFixed(2)} tokens`,
    );
    logger.debug(
      `   Trader: ${buyer}, Fee: $${tradeEvent.feeAmountUSD.toFixed(2)}, New Price: $${tradeEvent.spotPriceUSD.toFixed(6)}`,
    );

    // Check for whale trade
    if (tradeEvent.reserveAmountUSD > this.thresholds.largeTradeUSD) {
      const alert: EventAlert = {
        type: 'whale_trade',
        priority: 'high',
        message: `🐋 Large BUY: $${tradeEvent.reserveAmountUSD.toFixed(2)} on ${tradeEvent.modelId}`,
        event: tradeEvent,
        metadata: {
          tradeUSD: tradeEvent.reserveAmountUSD,
          threshold: this.thresholds.largeTradeUSD,
        },
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
  private async handleSellEvent(
    poolConfig: PoolConfig,
    data: {
      seller: string;
      tokensIn: bigint;
      reserveOut: bigint;
      fee: bigint;
      spotPrice: bigint;
      event: ConfirmedEvent;
    },
  ): Promise<void> {
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
      timestamp: event.timestamp,
      logIndex: event.index,
      blockHash: event.blockHash,
    };

    logger.info(
      `🔴 SELL: ${tradeEvent.modelId} - ${tradeEvent.tokenAmountFormatted.toFixed(2)} tokens → $${tradeEvent.reserveAmountUSD.toFixed(2)}`,
    );
    logger.debug(
      `   Trader: ${seller}, Fee: $${tradeEvent.feeAmountUSD.toFixed(2)}, New Price: $${tradeEvent.spotPriceUSD.toFixed(6)}`,
    );

    // Check for whale trade
    if (tradeEvent.reserveAmountUSD > this.thresholds.largeTradeUSD) {
      const alert: EventAlert = {
        type: 'whale_trade',
        priority: 'high',
        message: `🐋 Large SELL: $${tradeEvent.reserveAmountUSD.toFixed(2)} on ${tradeEvent.modelId}`,
        event: tradeEvent,
        metadata: {
          tradeUSD: tradeEvent.reserveAmountUSD,
          threshold: this.thresholds.largeTradeUSD,
        },
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
  private async handleFeesDepositedEvent(
    poolConfig: PoolConfig,
    data: {
      depositor: string;
      amount: bigint;
      newReserveBalance: bigint;
      newSpotPrice: bigint;
      event: ConfirmedEvent;
    },
  ): Promise<void> {
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
      timestamp: event.timestamp,
      logIndex: event.index,
      blockHash: event.blockHash,
    };

    logger.info(`💰 FEES DEPOSITED: ${feeEvent.modelId} - $${feeEvent.amountUSD.toFixed(2)}`);
    logger.debug(
      `   Depositor: ${depositor}, New Reserve: $${Number(ethers.formatUnits(newReserveBalance, 6)).toFixed(2)}`,
    );

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
    event: ConfirmedEvent,
    isPaused: boolean,
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
      timestamp: event.timestamp,
      logIndex: event.index,
      blockHash: event.blockHash,
    };

    logger.warn(`🚨 ${isPaused ? 'PAUSED' : 'UNPAUSED'}: ${poolConfig.modelId} by ${account}`);
    logger.warn(`   Tx: ${event.transactionHash}`);

    const planned =
      isPaused &&
      this.maintenance.find(
        (entry) =>
          entry.pool.toLowerCase() === poolConfig.ammAddress.toLowerCase() &&
          entry.actors.some((actor) => actor.toLowerCase() === account.toLowerCase()) &&
          Date.parse(entry.expiresAt) > Date.now() &&
          Date.parse(entry.expiresAt) <= Date.now() + 86400_000,
      );
    if (planned) {
      await this.store.put(
        `maintenance:${poolConfig.ammAddress}`,
        Date.parse(planned.expiresAt),
        Date.parse(planned.expiresAt) - Date.now(),
      );
    } else {
      await this.store.remove(`maintenance:${poolConfig.ammAddress}`);
    }
    // Planned pauses and recovery are informational; an unexpected actor always remains critical.
    const alert: EventAlert = {
      type: 'security_event',
      priority: isPaused && !planned ? 'critical' : 'info',
      message: `${isPaused ? '🚨' : '✅'} ${isPaused ? 'PAUSED' : 'UNPAUSED'}: ${poolConfig.modelId} by ${account}`,
      event: securityEvent,
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
    event: ConfirmedEvent,
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
      timestamp: event.timestamp,
      logIndex: event.index,
      blockHash: event.blockHash,
    };

    logger.warn(`🚨 OWNERSHIP TRANSFERRED: ${poolConfig.modelId}`);
    logger.warn(`   From: ${previousOwner} → To: ${newOwner}`);
    logger.warn(`   Tx: ${event.transactionHash}`);

    // Always alert on ownership transfer
    const alert: EventAlert = {
      type: 'security_event',
      priority: 'critical',
      message: `🚨 OWNERSHIP TRANSFERRED: ${poolConfig.modelId} from ${previousOwner} to ${newOwner}`,
      event: securityEvent,
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
  private async handleParametersUpdatedEvent(
    poolConfig: PoolConfig,
    data: {
      newCrr: bigint;
      newTradeFee: bigint;
      newProtocolFee: number;
      event: ConfirmedEvent;
    },
  ): Promise<void> {
    const { newCrr, newTradeFee, newProtocolFee, event } = data;

    const securityEvent: SecurityEvent = {
      type: 'parameters_updated',
      poolAddress: poolConfig.ammAddress,
      contractAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      actor: (await this.provider.getTransaction(event.transactionHash))?.from || 'unknown',
      details: {
        oldCrr: poolConfig.crr,
        newCrr: Number(newCrr),
        oldTradeFee: poolConfig.tradeFee,
        newTradeFee: Number(newTradeFee),
        oldProtocolFee: poolConfig.protocolFee,
        newProtocolFee,
      },
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      timestamp: event.timestamp,
      logIndex: event.index,
      blockHash: event.blockHash,
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
      event: securityEvent,
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
   * Get overall listening status
   */
  getIsListening(): boolean {
    return this.isListening;
  }

  /**
   * Get number of pools being listened to
   */
  getListeningPoolCount(): number {
    return this.poolContracts.size;
  }
}
