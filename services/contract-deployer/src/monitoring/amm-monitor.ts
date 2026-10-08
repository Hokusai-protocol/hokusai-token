import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import {
  MonitoringConfig,
  createMonitoringConfig,
  getConfigSummary,
} from '../config/monitoring-config';
import { PoolDiscovery, PoolDiscoveryOrigin } from './pool-discovery';
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
  ingestion: {
    healthy: boolean;
    sampled: boolean;
    reason: string | null;
    lastBlockNumber: number | null;
    lastAdvanceAtMs: number | null;
    usingBackupProvider: boolean;
  };
  errors?: string[];
}

export class AMMMonitor {
  private config: MonitoringConfig;
  private provider: ethers.Provider;
  private primaryProvider?: ethers.Provider;
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
  private ingestionSampled: boolean = false;
  private ingestionReason: string | null = null;
  private heartbeatInFlight: boolean = false;
  private providerRebindInFlight: boolean = false;
  private backupActivatedAtMs: number | null = null;
  private primaryRecoverySuccesses: number = 0;
  private consecutivePrimaryRpcErrors: number = 0;
  private backupRejectedUntilMs: number | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private alertCallbacks: Array<(alert: StateAlert | EventAlert) => Promise<void>> = [];
  private alerts: Array<StateAlert | EventAlert> = [];
  private events: Array<TradeEvent | SecurityEvent | FeeEvent> = [];

  constructor(config?: MonitoringConfig) {
    // Load or use provided config
    this.config = config || createMonitoringConfig();

    this.primaryProvider = this.createMonitoringProvider(this.config.rpcUrl);
    this.provider = this.primaryProvider;

    // Create backup provider if configured
    if (this.config.backupRpcUrl) {
      this.backupProvider = this.createMonitoringProvider(this.config.backupRpcUrl);
      if (this.backupProvider instanceof ethers.JsonRpcProvider) {
        this.backupProvider.pollingInterval = this.config.thresholds.backupRpcPollingIntervalMs;
      }
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

      // 4. Start the ingestion-health heartbeat (HOK-1698): detect a blind monitor (RPC down /
      //    stale or stuck head) so the other alerts can be trusted to actually fire.
      await this.startIngestionHeartbeat();

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

      for (const provider of new Set([this.provider, this.primaryProvider, this.backupProvider])) {
        this.destroyProvider(provider, true);
      }

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

    // Register before bootstrap hydration so every pool is attached to monitoring, while the origin
    // lets us suppress "new pool" alerts for inventory that existed before this process started.
    this.poolDiscovery.onPoolDiscovered((pool, origin) => {
      logger.info(`Pool discovered (${origin}): ${pool.modelId} at ${pool.ammAddress}`);
      return this.handlePoolDiscovered(pool, origin);
    });

    // Add initial pools from config
    if (this.config.initialPools.length > 0) {
      await this.poolDiscovery.addInitialPools(this.config.initialPools);
    }

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

  /** Prefer WebSockets only when the configured endpoint is explicitly WS or known to support it. */
  private createMonitoringProvider(rpcUrl: string): ethers.Provider {
    if (rpcUrl.startsWith('ws://') || rpcUrl.startsWith('wss://')) {
      logger.info('Using WebSocket provider for event listening');
      return this.createWebSocketProvider(rpcUrl);
    }

    try {
      const url = new URL(rpcUrl);
      if (url.hostname.endsWith('alchemy.com')) {
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        logger.info(`Using Alchemy WebSocket provider: ${url.origin}/...`);
        return this.createWebSocketProvider(url.toString());
      }
    } catch (error) {
      logger.warn('Could not parse RPC URL for WebSocket selection; using HTTP', { error });
    }

    logger.info('Using HTTP polling provider for event listening');
    return new ethers.JsonRpcProvider(rpcUrl);
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

    if (this.providerRebindInFlight) {
      logger.warn('Provider rebind already in progress');
      return;
    }

    this.providerRebindInFlight = true;
    const previousPrimaryProvider = this.primaryProvider;
    try {
      const network = await this.backupProvider.getNetwork();
      const blockNumber = await this.backupProvider.getBlockNumber();
      if (Number(network.chainId) !== this.config.chainId) {
        throw new Error(
          `Backup RPC chain ID mismatch: expected ${this.config.chainId}, got ${network.chainId}`,
        );
      }
      await this.probeProviderUnderLoad(this.backupProvider);
      logger.info(`Backup provider verified on ${network.name} at block ${blockNumber}`);

      await this.rebindProvider(this.backupProvider);
      this.usingBackupProvider = true;
      this.backupActivatedAtMs = Date.now();
      this.primaryRecoverySuccesses = 0;
      this.primaryProvider = undefined;
      this.destroyProvider(previousPrimaryProvider);
      logger.warn('Monitoring components rebound to backup RPC provider');
    } catch (error) {
      logger.error('Backup provider also failed:', error);
      throw error;
    } finally {
      this.providerRebindInFlight = false;
    }
  }

  /**
   * A rate-limited backup still answers chainId/blockNumber, then rejects the burst of calls a
   * rebind makes (-32005 Too Many Requests). Send a comparable batch so that backup is refused
   * up front instead of leaving the monitor half-blind on it.
   */
  private async probeProviderUnderLoad(provider: ethers.Provider): Promise<void> {
    const addresses = [
      this.config.contracts.ammFactory,
      ...this.poolDiscovery.getDiscoveredPools().map((pool) => pool.ammAddress),
    ]
      .filter((address): address is string => !!address)
      .slice(0, 10);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(addresses.map((address) => provider.getCode(address))),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('RPC load probe timed out')),
            this.config.thresholds.ingestionRpcTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * React to a heartbeat RPC error on the primary. Primary blips are usually brief, so first
   * reconnect to a fresh primary provider (this also replaces a dropped WebSocket). Only after
   * consecutive failures move to the backup, and skip a backup recently rejected as unusable.
   * Returns true when the active provider changed.
   */
  private async handlePrimaryRpcError(nowMs: number = Date.now()): Promise<boolean> {
    if (this.providerRebindInFlight) {
      return false;
    }

    const backupAvailable =
      !!this.backupProvider &&
      (this.backupRejectedUntilMs === null || nowMs >= this.backupRejectedUntilMs);

    if (
      backupAvailable &&
      this.consecutivePrimaryRpcErrors >= this.config.thresholds.backupRpcFailoverConsecutiveErrors
    ) {
      try {
        await this.switchToBackupProvider();
        this.backupRejectedUntilMs = null;
        return true;
      } catch (error) {
        this.backupRejectedUntilMs = nowMs + this.config.thresholds.backupRpcRejectCooldownMs;
        logger.error('Backup RPC rejected; staying on primary and retrying it', {
          error: error instanceof Error ? error.message : String(error),
          retryBackupAfterMs: this.config.thresholds.backupRpcRejectCooldownMs,
        });
        // A failed backup rebind can leave components on the backup; reconnect them to a primary.
      }
    }

    return this.reconnectPrimary();
  }

  /** Recreate every listener on a fresh primary provider if the primary answers right now. */
  private async reconnectPrimary(): Promise<boolean> {
    let candidateProvider: ethers.Provider | undefined;
    let promoted = false;
    this.providerRebindInFlight = true;
    try {
      candidateProvider = this.createMonitoringProvider(this.config.rpcUrl);
      const blockNumber = await this.verifyProviderCandidate(candidateProvider);
      const previousProvider = this.provider;

      await this.rebindProvider(candidateProvider);
      this.primaryProvider = candidateProvider;
      promoted = true;
      if (previousProvider !== this.backupProvider) {
        this.destroyProvider(previousProvider);
      }

      logger.warn('Primary RPC reconnected; monitoring components rebound to a fresh provider', {
        blockNumber,
        consecutivePrimaryRpcErrors: this.consecutivePrimaryRpcErrors,
      });
      return true;
    } catch (error) {
      logger.warn('Primary RPC reconnect failed', {
        error: error instanceof Error ? error.message : String(error),
        consecutivePrimaryRpcErrors: this.consecutivePrimaryRpcErrors,
        backupThreshold: this.config.thresholds.backupRpcFailoverConsecutiveErrors,
      });
      return false;
    } finally {
      this.providerRebindInFlight = false;
      if (!promoted) {
        this.destroyProvider(candidateProvider);
      }
    }
  }

  /** Replace every provider-bound contract and subscription, then resume all discovered pools. */
  private async rebindProvider(provider: ethers.Provider): Promise<void> {
    const pools = this.poolDiscovery.getDiscoveredPools();

    this.poolDiscovery.stopListening();
    this.stateTracker.stopAllTracking();
    this.eventListener.stopAllListening();

    this.provider = provider;
    this.poolDiscovery.setProvider(provider);
    this.stateTracker.setProvider(provider);
    this.eventListener.setProvider(provider);

    for (const pool of pools) {
      await this.startMonitoringPool(pool.ammAddress, pool);
    }

    if (this.config.poolDiscoveryEnabled) {
      await this.poolDiscovery.startListening('latest');
    }
  }

  /** Probe the primary over HTTP so recovery checks do not leave throwaway WebSockets open. */
  private createPrimaryProbeProvider(): ethers.JsonRpcProvider {
    const url = new URL(this.config.rpcUrl);
    if (url.protocol === 'wss:') {
      url.protocol = 'https:';
    } else if (url.protocol === 'ws:') {
      url.protocol = 'http:';
    }
    return new ethers.JsonRpcProvider(url.toString());
  }

  private async verifyProviderCandidate(provider: ethers.Provider): Promise<number> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.all([provider.getNetwork(), provider.getBlockNumber()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Primary RPC recovery probe timed out')),
            this.config.thresholds.ingestionRpcTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
      const [network, blockNumber] = result;
      if (Number(network.chainId) !== this.config.chainId) {
        throw new Error(
          `Primary RPC chain ID mismatch: expected ${this.config.chainId}, got ${network.chainId}`,
        );
      }

      const currentBlockNumber = this.ingestionHealth.lastBlockNumber;
      if (
        currentBlockNumber !== null &&
        blockNumber + this.config.thresholds.primaryRpcFailbackMaxBlockLag < currentBlockNumber
      ) {
        throw new Error(
          `Primary RPC is ${currentBlockNumber - blockNumber} blocks behind the active provider`,
        );
      }
      return blockNumber;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * The backup is temporary. Probe the configured primary on every heartbeat while failed over,
   * require stable consecutive successes plus a minimum dwell, then recreate every listener on a
   * fresh primary provider. This avoids both permanent backup use and rapid provider flapping.
   */
  private async maybeFailBackToPrimary(nowMs: number = Date.now()): Promise<boolean> {
    if (
      !this.usingBackupProvider ||
      this.backupActivatedAtMs === null ||
      this.providerRebindInFlight
    ) {
      return false;
    }

    let probeProvider: ethers.Provider | undefined;
    let candidateProvider: ethers.Provider | undefined;
    let promoted = false;
    try {
      probeProvider = this.createPrimaryProbeProvider();
      const blockNumber = await this.verifyProviderCandidate(probeProvider);
      this.primaryRecoverySuccesses += 1;

      const backupDurationMs = nowMs - this.backupActivatedAtMs;
      const stable =
        this.primaryRecoverySuccesses >= this.config.thresholds.primaryRpcFailbackSuccesses;
      const dwellComplete =
        backupDurationMs >= this.config.thresholds.primaryRpcFailbackMinBackupMs;

      logger.info('Primary RPC recovery probe succeeded', {
        blockNumber,
        consecutiveSuccesses: this.primaryRecoverySuccesses,
        requiredSuccesses: this.config.thresholds.primaryRpcFailbackSuccesses,
        backupDurationMs,
        dwellComplete,
      });

      if (!stable || !dwellComplete) {
        return false;
      }

      candidateProvider = this.createMonitoringProvider(this.config.rpcUrl);
      const verifiedBlockNumber = await this.verifyProviderCandidate(candidateProvider);

      this.providerRebindInFlight = true;
      try {
        await this.rebindProvider(candidateProvider);
      } catch (error) {
        // A candidate can pass its RPC probe but still fail while recreating contracts/filters.
        // Put every component back on the known backup before discarding that candidate.
        if (this.backupProvider && this.provider === candidateProvider) {
          try {
            await this.rebindProvider(this.backupProvider);
          } catch (rollbackError) {
            logger.error('Failed to restore backup provider after primary rebind failure', {
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
        throw error;
      }
      this.primaryProvider = candidateProvider;
      this.usingBackupProvider = false;
      this.backupActivatedAtMs = null;
      this.primaryRecoverySuccesses = 0;
      this.consecutivePrimaryRpcErrors = 0;
      promoted = true;

      logger.warn('Primary RPC recovered; monitoring components returned to primary provider', {
        blockNumber: verifiedBlockNumber,
      });
      await Promise.all([
        this.alertManager.recordRpcProviderState(false),
        this.handleAlert(this.buildPrimaryRpcRecoveredAlert(verifiedBlockNumber)),
      ]);
      return true;
    } catch (error) {
      this.primaryRecoverySuccesses = 0;
      logger.warn('Primary RPC recovery probe failed; remaining on backup provider', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      this.providerRebindInFlight = false;
      this.destroyProvider(probeProvider);
      if (!promoted) {
        this.destroyProvider(candidateProvider);
      }
    }
  }

  private destroyProvider(provider?: ethers.Provider, destroyCurrent: boolean = false): void {
    if (!provider || (!destroyCurrent && provider === this.provider)) {
      return;
    }
    try {
      const destroy = (provider as ethers.Provider & { destroy?: () => void }).destroy;
      destroy?.call(provider);
    } catch (error) {
      logger.warn('Failed to close replaced RPC provider', {
        error: error instanceof Error ? error.message : String(error),
      });
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
  private async startIngestionHeartbeat(): Promise<void> {
    const thresholds = {
      staleBlockMs: this.config.thresholds.ingestionStaleBlockMs,
      stuckMs: this.config.thresholds.ingestionStuckMs,
    };
    const rpcTimeoutMs = this.config.thresholds.ingestionRpcTimeoutMs;

    const tick = async (): Promise<void> => {
      // Liveness (HOK-1698): a Heartbeat metric each tick so the health report can tell "no alerts"
      // apart from "monitor is dead" (absence of Heartbeat => the monitor itself is down).
      // Emit before sampling RPC so a hung provider cannot suppress the detector liveness signal.
      const heartbeatMetric = this.alertManager.recordHeartbeat();

      const previousHealth = this.ingestionHealth;
      let sample = await this.sampleLatestBlock(rpcTimeoutMs);

      let assessment = assessIngestionHealth(previousHealth, sample, Date.now(), thresholds);
      this.ingestionHealth = assessment.state;
      this.ingestionSampled = true;
      this.ingestionReason = assessment.healthy ? null : assessment.reason;

      // On a primary RPC error, reconnect to the primary first and fall back to the backup only
      // after consecutive failures. Once on the backup, continuously probe the primary and return
      // only after it is stable and the anti-flap dwell has elapsed.
      let providerChanged = false;
      if (!this.usingBackupProvider) {
        if (!assessment.healthy && assessment.reason === 'rpc_error') {
          this.consecutivePrimaryRpcErrors += 1;
          providerChanged = await this.handlePrimaryRpcError();
        } else if (sample.ok) {
          this.consecutivePrimaryRpcErrors = 0;
        }
      } else {
        providerChanged = await this.maybeFailBackToPrimary();
      }

      if (providerChanged) {
        // The assessment above sampled the previous provider. Re-sample the freshly rebound one,
        // against the pre-tick state, so a blip healed within this tick neither pages nor flips the
        // health gauge, and readiness reflects the provider now serving listeners.
        sample = await this.sampleLatestBlock(rpcTimeoutMs);
        assessment = assessIngestionHealth(previousHealth, sample, Date.now(), thresholds);
        this.ingestionHealth = assessment.state;
        this.ingestionReason = assessment.healthy ? null : assessment.reason;
        if (sample.ok && !this.usingBackupProvider) {
          this.consecutivePrimaryRpcErrors = 0;
        }
      }

      await Promise.all([
        heartbeatMetric,
        this.alertManager.recordDependencyHealth('IngestionHealthy', assessment.healthy),
        this.alertManager.recordRpcProviderState(this.usingBackupProvider),
      ]);
      if (!assessment.transitioned) {
        return;
      }

      if (!assessment.healthy) {
        await this.handleAlert(
          this.buildIngestionAlert(
            'critical',
            `Monitor ingestion unhealthy (${assessment.reason}) — alerts may be blind${
              this.usingBackupProvider ? '; temporary backup RPC is active' : ''
            }`,
            assessment.reason,
          ),
        );
      } else {
        await this.handleAlert(
          this.buildIngestionAlert('medium', 'Monitor ingestion recovered', 'recovered'),
        );
      }
    };

    // Establish readiness before the server begins accepting health checks.
    await tick();

    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatInFlight) {
        logger.warn('Skipping overlapping ingestion heartbeat');
        return;
      }
      this.heartbeatInFlight = true;
      void tick().finally(() => {
        this.heartbeatInFlight = false;
      });
    }, this.config.thresholds.ingestionHeartbeatIntervalMs);
    // Don't keep the process alive solely for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  private async sampleLatestBlock(timeoutMs: number): Promise<IngestionSample> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const block = await Promise.race([
        this.provider.getBlock('latest'),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), timeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (!block) {
        return { ok: false };
      }
      return { ok: true, blockNumber: block.number, blockTimestampMs: block.timestamp * 1000 };
    } catch {
      return { ok: false };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
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

  private buildPrimaryRpcRecoveredAlert(blockNumber: number): StateAlert {
    return {
      type: 'rpc_primary_recovered',
      priority: 'medium',
      poolAddress: 'monitor',
      modelId: 'monitor',
      message: 'Primary RPC recovered; returned monitoring to the primary provider',
      metadata: {
        blockNumber,
        usingBackupProvider: false,
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

  private async handlePoolDiscovered(
    pool: {
      ammAddress: string;
      modelId: string;
      crr: number;
      tradeFee: number;
      protocolFee: number;
      ibrDuration: number;
    },
    origin: PoolDiscoveryOrigin,
  ): Promise<void> {
    await this.startMonitoringPool(pool.ammAddress, pool);

    if (this.config.alertsEnabled && origin === 'live') {
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

    const components = {
      poolDiscovery: !this.config.poolDiscoveryEnabled || this.poolDiscovery.getPoolCount() > 0,
      stateTracking:
        !this.config.statePollingEnabled || this.stateTracker.getTrackedPoolCount() > 0,
      eventListening:
        !this.config.eventListenersEnabled || this.eventListener.getListeningPoolCount() > 0,
      metricsCollection: this.metricsCollector.getAllPoolMetrics().length > 0,
    };
    const componentsHealthy = Object.values(components).every(Boolean);
    const ingestionHealthy = this.ingestionSampled && this.ingestionHealth.healthy;
    const status: 'healthy' | 'degraded' | 'unhealthy' =
      !this.isRunning || !ingestionHealthy
        ? 'unhealthy'
        : !componentsHealthy || this.errors.length > 5
          ? 'degraded'
          : 'healthy';

    return {
      status,
      isHealthy: status === 'healthy',
      uptime,
      poolsMonitored: this.poolDiscovery.getPoolCount(),
      components,
      componentsStatus: components, // Alias for backwards compatibility
      lastUpdateTime: Date.now(),
      ingestion: {
        healthy: ingestionHealthy,
        sampled: this.ingestionSampled,
        reason: this.ingestionReason,
        lastBlockNumber: this.ingestionHealth.lastBlockNumber,
        lastAdvanceAtMs: this.ingestionHealth.lastAdvanceAtMs,
        usingBackupProvider: this.usingBackupProvider,
      },
      errors: this.errors.length > 0 ? [...this.errors] : undefined,
    };
  }

  /** Publish the Redis readiness gauge from the standalone server's dependency check. */
  async recordRedisReadiness(ready: boolean): Promise<void> {
    await this.alertManager.recordDependencyHealth('RedisReady', ready);
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
