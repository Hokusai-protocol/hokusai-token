import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import {
  MonitoringConfig,
  createMonitoringConfig,
  getConfigSummary,
} from '../config/monitoring-config';
import { PoolDiscovery } from './pool-discovery';
import { StateTracker, StateAlert } from './state-tracker';
import { EventListener, TradeEvent, SecurityEvent, FeeEvent, EventAlert } from './event-listener';
import { MetricsCollector } from './metrics-collector';
import { AlertManager, AlertManagerConfig } from './alert-manager';
import { attachSocketErrorHandler, SocketLike } from './ws-error-handler';
import {
  assessIngestionHealth,
  IngestionHealthState,
  IngestionSample,
  INITIAL_INGESTION_HEALTH,
} from './ingestion-health';

/**
 * AMM Monitor
 *
 * Main orchestrator for Hokusai AMM monitoring.
 * Coordinates all monitoring components:
 * - Pool Discovery (auto-detect new pools)
 * - State Tracker (poll pool state every 12s)
 * - Event Listener (listen for Buy/Sell/Pause events)
 * - Metrics Collector (aggregate volume, trades, fees)
 *
 * Usage:
 *   const monitor = new AMMMonitor();
 *   await monitor.start();
 */

export interface AMMMonitorHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  isHealthy: boolean;
  uptime: number;
  poolsMonitored: number;
  components: {
    poolDiscovery: boolean;
    stateTracking: boolean;
    eventListening: boolean;
    metricsCollection: boolean;
  };
  componentsStatus: {
    poolDiscovery: boolean;
    stateTracking: boolean;
    eventListening: boolean;
    metricsCollection: boolean;
  };
  lastUpdateTime: number;
  errors?: string[];
}

export class AMMMonitor {
  private config: MonitoringConfig;
  private provider: ethers.Provider;
  private backupProvider?: ethers.Provider;
  private usingBackupProvider: boolean = false;

  // Components
  private poolDiscovery: PoolDiscovery;
  private stateTracker: StateTracker;
  private eventListener: EventListener;
  private metricsCollector: MetricsCollector;
  private alertManager: AlertManager;

  // State
  private isRunning: boolean = false;
  private startTime: number = 0;
  private errors: string[] = [];
  private ingestionHealth: IngestionHealthState = INITIAL_INGESTION_HEALTH;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private alertCallbacks: Array<(alert: StateAlert | EventAlert) => Promise<void>> = [];
  private alerts: Array<StateAlert | EventAlert> = [];
  private events: Array<TradeEvent | SecurityEvent | FeeEvent> = [];

  constructor(config?: MonitoringConfig) {
    // Load or use provided config
    this.config = config || createMonitoringConfig();

    // Create provider - use WebSocket if URL starts with ws:// or wss://
    if (this.config.rpcUrl.startsWith('ws://') || this.config.rpcUrl.startsWith('wss://')) {
      this.provider = this.createWebSocketProvider(this.config.rpcUrl);
      logger.info('Using WebSocket provider for event listening (reduces RPC calls)');
    } else {
      // Convert https:// to wss:// for Alchemy URLs
      const wsUrl = this.config.rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      if (wsUrl.startsWith('wss://') || wsUrl.startsWith('ws://')) {
        try {
          this.provider = this.createWebSocketProvider(wsUrl);
          logger.info(`Converted to WebSocket provider: ${wsUrl.split('.com')[0]}.com/...`);
        } catch (error) {
          logger.warn('Failed to create WebSocket provider, falling back to HTTP', { error });
          this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
        }
      } else {
        this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
        logger.warn('Using HTTP provider - consider switching to WebSocket for efficiency');
      }
    }

    // Create backup provider if configured
    if (this.config.backupRpcUrl) {
      this.backupProvider = new ethers.JsonRpcProvider(this.config.backupRpcUrl);
    }

    // Initialize components
    this.poolDiscovery = new PoolDiscovery(this.provider, this.config.contracts.ammFactory);

    this.stateTracker = new StateTracker(this.provider, this.config.thresholds, {
      onStateUpdate: (state) => {
        this.metricsCollector.updatePoolState(state);
        return Promise.resolve();
      },
      onAlert: (alert) => this.handleAlert(alert),
    });

    this.eventListener = new EventListener(this.provider, this.config.thresholds, {
      onTradeEvent: (event) => {
        this.metricsCollector.recordTrade(event);
        return this.logTradeEvent(event);
      },
      onSecurityEvent: (event) => this.logSecurityEvent(event),
      onFeeEvent: (event) => {
        this.metricsCollector.recordFeeDeposit(event);
        return this.logFeeEvent(event);
      },
      onAlert: (alert) => this.handleAlert(alert),
    });

    this.metricsCollector = new MetricsCollector();

    // Initialize alert manager
    const alertManagerConfig: AlertManagerConfig = {
      enabled: this.config.alertsEnabled,
      emailEnabled: this.config.alertsEnabled && !!this.config.alertEmail,
      emailRecipients: this.config.alertEmail ? [this.config.alertEmail] : [],
      emailFrom: process.env.ALERT_EMAIL_FROM || 'alerts@hokus.ai',
      awsSesRegion: this.config.awsSesRegion,
      maxAlertsPerHour: parseInt(process.env.MAX_ALERTS_PER_HOUR || '10', 10),
      maxAlertsPerDay: parseInt(process.env.MAX_ALERTS_PER_DAY || '50', 10),
      deduplicationWindowMs: parseInt(process.env.ALERT_DEDUP_WINDOW_MS || '300000', 10), // 5 minutes default
      // HOK-1698: emit a CloudWatch metric per alert so the health report + mttr can see them.
      cloudWatchEnabled: process.env.MONITORING_CLOUDWATCH_ENABLED !== 'false',
      metricsNamespace: process.env.MONITORING_METRICS_NAMESPACE || 'Hokusai/ContractMonitoring',
      // Deploy environment (development/production) — must match the health-report query's Environment
      // dimension (cloudwatch_service_health_report.py uses HOKUSAI_ENVIRONMENT, default development),
      // NOT the chain network. Otherwise the report would query the wrong metric series.
      environment: process.env.HOKUSAI_ENVIRONMENT || process.env.ENVIRONMENT || 'development',
    };

    this.alertManager = new AlertManager(alertManagerConfig);

    logger.info('AMM Monitor initialized');
  }

  /**
   * Start monitoring
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('AMM Monitor already running');
      return;
    }

    if (!this.config.enabled) {
      logger.warn('Monitoring is disabled in configuration');
      return;
    }

    logger.info('🚀 Starting AMM Monitor...');
    logger.info(getConfigSummary(this.config));

    try {
      // Verify provider connection
      await this.verifyProviderConnection();

      // Start components
      this.startTime = Date.now();
      this.isRunning = true;

      // 1. Load initial pools and set up discovery
      await this.initializePoolDiscovery();

      // 2. Discover existing pools
      if (this.config.poolDiscoveryEnabled) {
        await this.poolDiscovery.discoverExistingPools();
      }

      // 3. Start pool discovery listener
      if (this.config.poolDiscoveryEnabled) {
        await this.poolDiscovery.startListening(this.config.eventPollingFromBlock);
      }

      // 4. Start monitoring all discovered pools
      const pools = this.poolDiscovery.getDiscoveredPools();
      for (const pool of pools) {
        await this.startMonitoringPool(pool.ammAddress, pool);
      }

      // 5. Start the ingestion-health heartbeat (HOK-1698): detect a blind monitor (RPC down /
      //    stale or stuck head) so the other alerts can be trusted to actually fire.
      this.startIngestionHeartbeat();

      // Log summary
      this.logStartupSummary();

      logger.info('✅ AMM Monitor started successfully');
    } catch (error) {
      logger.error('Failed to start AMM Monitor:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop monitoring
   */
  stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('AMM Monitor not running');
      return Promise.resolve();
    }

    logger.info('🛑 Stopping AMM Monitor...');

    try {
      // Stop all components
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      this.poolDiscovery.stopListening();
      this.stateTracker.stopAllTracking();
      this.eventListener.stopAllListening();

      this.isRunning = false;

      // Log final metrics
      logger.info(this.metricsCollector.getMetricsSummary());

      logger.info('✅ AMM Monitor stopped');
      return Promise.resolve();
    } catch (error) {
      logger.error('Error stopping AMM Monitor:', error);
      return Promise.reject(error);
    }
  }

  /**
   * Initialize pool discovery
   */
  private async initializePoolDiscovery(): Promise<void> {
    logger.info('Initializing pool discovery...');

    // Add initial pools from config
    if (this.config.initialPools.length > 0) {
      await this.poolDiscovery.addInitialPools(this.config.initialPools);
    }

    // Set up callback for newly discovered pools
    this.poolDiscovery.onPoolDiscovered((pool) => {
      logger.info(`🆕 New pool discovered: ${pool.modelId} at ${pool.ammAddress}`);
      return this.handlePoolDiscovered(pool);
    });

    logger.info('Pool discovery initialized');
  }

  /**
   * Start monitoring a specific pool
   */
  private async startMonitoringPool(poolAddress: string, poolConfig: any): Promise<void> {
    logger.info(`Starting monitoring for ${poolConfig.modelId} (${poolAddress})`);

    try {
      // Initialize metrics
      this.metricsCollector.initializePool(poolAddress, poolConfig.modelId);

      // Start state tracking (if enabled)
      if (this.config.statePollingEnabled) {
        await this.stateTracker.startTracking(poolConfig, this.config.statePollingIntervalMs);
      }

      // Start event listening (if enabled)
      if (this.config.eventListenersEnabled) {
        this.eventListener.startListeningToPool(poolConfig);
      }

      logger.info(`✅ Monitoring started for ${poolConfig.modelId}`);
    } catch (error) {
      logger.error(`Failed to start monitoring for ${poolConfig.modelId}:`, error);
      this.errors.push(`Failed to monitor ${poolConfig.modelId}: ${error}`);
    }
  }

  /**
   * Create a WebSocketProvider with an error handler attached to its underlying socket.
   *
   * Without this, a dropped Alchemy WebSocket throws an uncaught error that kills the whole process
   * (this is what crash-looped the in-process mint relayer — HOK B2). The handler logs and survives;
   * the ingestion heartbeat (startIngestionHeartbeat) detects the resulting rpc_error on its next
   * tick and fails over to the backup provider.
   */
  private createWebSocketProvider(wsUrl: string): ethers.WebSocketProvider {
    const provider = new ethers.WebSocketProvider(wsUrl);
    const attached = attachSocketErrorHandler(
      provider.websocket as unknown as SocketLike,
      (err: unknown) => {
        logger.error('WebSocket provider socket error (handled — monitor stays alive)', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    if (!attached) {
      logger.warn('Could not attach WebSocket error handler; socket unavailable at construction');
    }
    return provider;
  }

  /**
   * Verify provider connection
   */
  private async verifyProviderConnection(): Promise<void> {
    try {
      const network = await this.provider.getNetwork();
      const blockNumber = await this.provider.getBlockNumber();

      logger.info(`Connected to ${network.name} (Chain ID: ${network.chainId})`);
      logger.info(`Current block: ${blockNumber}`);

      // Verify chain ID matches config
      if (Number(network.chainId) !== this.config.chainId) {
        throw new Error(
          `Chain ID mismatch! Expected ${this.config.chainId}, got ${network.chainId}`,
        );
      }
    } catch (error) {
      logger.error('Failed to connect to RPC provider:', error);

      // Try backup provider
      if (this.backupProvider && !this.usingBackupProvider) {
        logger.warn('Attempting to use backup RPC provider...');
        await this.switchToBackupProvider();
      } else {
        throw error;
      }
    }
  }

  /**
   * Switch to backup provider
   */
  private async switchToBackupProvider(): Promise<void> {
    if (!this.backupProvider) {
      throw new Error('No backup provider configured');
    }

    try {
      const network = await this.backupProvider.getNetwork();
      logger.info(`Switched to backup provider: ${network.name}`);

      // Update components to use backup provider
      this.provider = this.backupProvider;
      this.usingBackupProvider = true;

      // Recreate components with new provider
      // Note: This is simplified - in production, components should support provider switching
      logger.warn('Provider switched - monitoring may be temporarily interrupted');
    } catch (error) {
      logger.error('Backup provider also failed:', error);
      throw error;
    }
  }

  /**
   * Handle alerts from any component
   */
  private async handleAlert(alert: StateAlert | EventAlert): Promise<void> {
    // Log alert
    const priorityEmoji = {
      critical: '🚨',
      high: '⚠️',
      medium: '📊',
    };

    logger.warn(
      `${priorityEmoji[alert.priority]} ALERT [${alert.priority.toUpperCase()}]: ${alert.message}`,
    );

    // Store alert for API access (keep last 100)
    this.alerts.push(alert);
    if (this.alerts.length > 100) {
      this.alerts.shift();
    }

    // Store alert in errors array (for health check)
    if (alert.priority === 'critical') {
      this.errors.push(alert.message);
      // Keep only last 10 errors
      if (this.errors.length > 10) {
        this.errors.shift();
      }
    }

    // Notify registered callbacks
    for (const callback of this.alertCallbacks) {
      try {
        await callback(alert);
      } catch (error) {
        logger.error('Alert callback failed:', error);
      }
    }

    // Send alert via AlertManager (Phase 2: Email notifications)
    try {
      await this.alertManager.sendAlert(alert);
    } catch (error) {
      logger.error('Failed to send alert via AlertManager:', error);
    }
  }

  /**
   * HOK-1698 — ingestion-health heartbeat. Periodically samples the chain head; if the RPC errors,
   * the head is stale, or the head stops advancing, the monitor is blind and every other alert
   * silently stops firing. Emits a critical alert on the unhealthy transition (once, not per tick)
   * and a recovery alert when it clears. On an RPC error it also attempts the backup provider.
   */
  private startIngestionHeartbeat(): void {
    const thresholds = {
      staleBlockMs: this.config.thresholds.ingestionStaleBlockMs,
      stuckMs: this.config.thresholds.ingestionStuckMs,
    };

    const tick = async (): Promise<void> => {
      let sample: IngestionSample;
      try {
        const block = await this.provider.getBlock('latest');
        sample = block
          ? { ok: true, blockNumber: block.number, blockTimestampMs: block.timestamp * 1000 }
          : { ok: false };
      } catch {
        sample = { ok: false };
      }

      // Liveness (HOK-1698): a Heartbeat metric each tick so the health report can tell "no alerts"
      // apart from "monitor is dead" (absence of Heartbeat => the monitor itself is down).
      void this.alertManager.recordHeartbeat();

      const assessment = assessIngestionHealth(
        this.ingestionHealth,
        sample,
        Date.now(),
        thresholds,
      );
      this.ingestionHealth = assessment.state;
      if (!assessment.transitioned) {
        return;
      }

      if (!assessment.healthy) {
        // RPC failure: try to fail over to the backup provider before paging.
        if (assessment.reason === 'rpc_error' && this.backupProvider && !this.usingBackupProvider) {
          try {
            await this.switchToBackupProvider();
          } catch (error) {
            logger.error('Backup provider failover failed during ingestion outage:', error);
          }
        }
        await this.handleAlert(
          this.buildIngestionAlert(
            'critical',
            `Monitor ingestion unhealthy (${assessment.reason}) — alerts may be blind`,
            assessment.reason,
          ),
        );
      } else {
        await this.handleAlert(
          this.buildIngestionAlert('medium', 'Monitor ingestion recovered', 'recovered'),
        );
      }
    };

    this.heartbeatTimer = setInterval(() => {
      void tick();
    }, this.config.thresholds.ingestionHeartbeatIntervalMs);
    // Don't keep the process alive solely for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  /** Build a monitor-level ingestion alert (not pool-specific; carries no pool currentState). */
  private buildIngestionAlert(
    priority: 'critical' | 'medium',
    message: string,
    reason: string | null,
  ): StateAlert {
    return {
      type: priority === 'critical' ? 'stale_ingestion' : 'ingestion_recovered',
      priority,
      poolAddress: 'monitor',
      modelId: 'monitor',
      message,
      metadata: {
        reason,
        usingBackupProvider: this.usingBackupProvider,
        lastBlockNumber: this.ingestionHealth.lastBlockNumber,
      },
    };
  }

  /**
   * Register alert callback
   */
  onAlert(callback: (alert: StateAlert | EventAlert) => Promise<void>): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Log trade event
   */
  private logTradeEvent(event: TradeEvent): Promise<void> {
    // Store event for API access (keep last 200)
    this.events.push(event);
    if (this.events.length > 200) {
      this.events.shift();
    }

    const emoji = event.type === 'buy' ? '🟢' : '🔴';
    const action = event.type === 'buy' ? 'BUY' : 'SELL';

    logger.info(
      `${emoji} ${action}: ${event.modelId} | ` +
        `$${event.reserveAmountUSD.toFixed(2)} | ` +
        `${event.tokenAmountFormatted.toFixed(2)} tokens | ` +
        `Fee: $${event.feeAmountUSD.toFixed(2)} | ` +
        `Price: $${event.spotPriceUSD.toFixed(6)}`,
    );

    return Promise.resolve();
  }

  /**
   * Log security event
   */
  private logSecurityEvent(event: SecurityEvent): Promise<void> {
    // Store event for API access (keep last 200)
    this.events.push(event);
    if (this.events.length > 200) {
      this.events.shift();
    }

    logger.warn(`🔐 SECURITY EVENT: ${event.type}`);
    logger.warn(`   Contract: ${event.contractAddress}`);
    logger.warn(`   Actor: ${event.actor}`);
    logger.warn(`   Details: ${JSON.stringify(event.details)}`);
    logger.warn(`   Tx: ${event.transactionHash}`);

    return Promise.resolve();
  }

  /**
   * Log fee event
   */
  private logFeeEvent(event: FeeEvent): Promise<void> {
    // Store event for API access (keep last 200)
    this.events.push(event);
    if (this.events.length > 200) {
      this.events.shift();
    }

    logger.info(
      `💰 FEE DEPOSIT: ${event.modelId} | ` +
        `$${event.amountUSD.toFixed(2)} | ` +
        `New Reserve: $${Number(ethers.formatUnits(event.newReserveBalance, 6)).toFixed(2)}`,
    );

    return Promise.resolve();
  }

  private async handlePoolDiscovered(pool: {
    ammAddress: string;
    modelId: string;
    crr: number;
    tradeFee: number;
    protocolFee: number;
    ibrDuration: number;
  }): Promise<void> {
    await this.startMonitoringPool(pool.ammAddress, pool);

    if (this.config.alertsEnabled) {
      await this.handleAlert({
        type: 'security_event',
        priority: 'medium',
        message: `🆕 New pool created: ${pool.modelId}`,
        event: {
          type: 'parameters_updated',
          contractAddress: pool.ammAddress,
          modelId: pool.modelId,
          actor: 'Factory',
          details: {
            crr: pool.crr,
            tradeFee: pool.tradeFee,
            protocolFee: pool.protocolFee,
            ibrDuration: pool.ibrDuration,
          },
          blockNumber: 0,
          transactionHash: '',
          timestamp: Math.floor(Date.now() / 1000),
        },
      });
    }
  }

  /**
   * Log startup summary
   */
  private logStartupSummary(): void {
    const pools = this.poolDiscovery.getDiscoveredPools();

    logger.info('\n' + '='.repeat(70));
    logger.info('AMM Monitor Status');
    logger.info('='.repeat(70));
    logger.info(`Pools Monitored:       ${pools.length}`);
    logger.info(
      `State Polling:         ${this.config.statePollingEnabled ? 'ENABLED' : 'DISABLED'} (${this.config.statePollingIntervalMs}ms)`,
    );
    logger.info(
      `Event Listeners:       ${this.config.eventListenersEnabled ? 'ENABLED' : 'DISABLED'}`,
    );
    logger.info(
      `Pool Discovery:        ${this.config.poolDiscoveryEnabled ? 'ENABLED' : 'DISABLED'}`,
    );
    logger.info(`Alerts:                ${this.config.alertsEnabled ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`Alert Email:           ${this.config.alertEmail}`);
    logger.info(`Backup RPC:            ${this.config.backupRpcUrl ? 'CONFIGURED' : 'NONE'}`);
    logger.info('='.repeat(70));

    logger.info('\nMonitored Pools:');
    for (const pool of pools) {
      logger.info(`  • ${pool.modelId} (${pool.ammAddress})`);
      logger.info(
        `    CRR: ${pool.crr / 10000}% | Fee: ${pool.tradeFee / 100}% | IBR: ${pool.ibrDuration / 86400}d`,
      );
    }

    logger.info('='.repeat(70) + '\n');
  }

  /**
   * Get health status
   */
  getHealth(): AMMMonitorHealth {
    const uptime = this.isRunning ? Date.now() - this.startTime : 0;

    const status: 'healthy' | 'degraded' | 'unhealthy' = !this.isRunning
      ? 'unhealthy'
      : this.errors.length > 5
        ? 'degraded'
        : 'healthy';

    const components = {
      poolDiscovery: this.poolDiscovery.getPoolCount() > 0,
      stateTracking: this.stateTracker.getTrackedPoolCount() > 0,
      eventListening: this.eventListener.getListeningPoolCount() > 0,
      metricsCollection: this.metricsCollector.getAllPoolMetrics().length > 0,
    };

    return {
      status,
      isHealthy: status === 'healthy',
      uptime,
      poolsMonitored: this.poolDiscovery.getPoolCount(),
      components,
      componentsStatus: components, // Alias for backwards compatibility
      lastUpdateTime: Date.now(),
      errors: this.errors.length > 0 ? [...this.errors] : undefined,
    };
  }

  /**
   * Get system metrics
   */
  getMetrics() {
    const systemMetrics = this.metricsCollector.getSystemMetrics();
    return {
      systemMetrics,
      poolMetrics: Array.from(systemMetrics.poolMetrics.values()),
    };
  }

  /**
   * Get pool metrics
   */
  getPoolMetrics(poolAddress: string) {
    return this.metricsCollector.getPoolMetrics(poolAddress);
  }

  /**
   * Get pool state
   */
  getPoolState(poolAddress: string) {
    return this.stateTracker.getCurrentState(poolAddress);
  }

  /**
   * Get all discovered pools
   */
  getPools() {
    return this.poolDiscovery.getDiscoveredPools();
  }

  /**
   * Get all discovered pools (alias for API compatibility)
   */
  getDiscoveredPools() {
    return this.poolDiscovery.getDiscoveredPools();
  }

  /**
   * Get pool state history
   */
  getPoolStateHistory(poolAddress: string, limit?: number) {
    return this.stateTracker.getStateHistory(poolAddress, limit);
  }

  /**
   * Get recent alerts (last 24 hours)
   */
  getRecentAlerts() {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    // Add timestamp to alerts when retrieving
    return this.alerts
      .map((alert, idx) => ({
        ...alert,
        timestamp: (alert as any).timestamp || Date.now() - (this.alerts.length - idx) * 60000, // Estimate if not present
      }))
      .filter((alert: any) => alert.timestamp >= oneDayAgo);
  }

  /**
   * Get recent events
   */
  getRecentEvents(limit: number = 50, type?: string) {
    const allEvents = this.events;
    // Filter by type if specified (works for TradeEvent, SecurityEvent, FeeEvent)
    const filtered = type ? allEvents.filter((e: any) => e.type === type) : allEvents;
    return filtered.slice(-limit);
  }

  /**
   * Check if monitoring is running
   */
  isMonitoring(): boolean {
    return this.isRunning;
  }

  /**
   * Get configuration
   */
  getConfig(): MonitoringConfig {
    return this.config;
  }

  /**
   * Get alert manager statistics
   */
  getAlertStats() {
    return this.alertManager.getStats();
  }
}
