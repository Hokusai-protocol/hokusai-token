import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';

/**
 * Monitoring Configuration
 *
 * Central configuration for AMM pool monitoring including:
 * - Alert thresholds
 * - Contract addresses
 * - Network settings
 * - Polling intervals
 */

export interface ContractAddresses {
  modelRegistry: string;
  tokenManager: string;
  hokusaiParams?: string;
  ammFactory: string;
  usageFeeRouter: string;
  deltaVerifier?: string;
  usdc: string;
}

export interface PoolConfig {
  modelId: string;
  tokenAddress: string;
  ammAddress: string;
  crr: number;
  tradeFee: number;
  protocolFee: number;
  ibrDuration: number;
  ibrEndsAt?: string;
}

export interface AlertThresholds {
  // Reserve monitoring
  minReserveUSD: number;              // Minimum reserve in USD
  reserveDropPercentage: number;      // Alert if reserve drops >X% in time window
  reserveDropWindowMs: number;        // Time window for reserve drop detection (ms)

  // Price volatility
  priceChange1hPercentage: number;    // Alert if price changes >X% in 1 hour
  priceChange24hPercentage: number;   // Alert if price changes >X% in 24 hours

  // Trade size monitoring
  largeTradeUSD: number;              // Alert on trades >X USD

  // Supply anomalies
  supplyChange1hPercentage: number;   // Alert if supply changes >X% in 1 hour

  // Gas monitoring
  highGasGwei: number;                // Warning if gas >X Gwei
  extremeGasGwei: number;             // Critical if gas >X Gwei

  // Fee accumulation
  treasuryFeesThresholdUSD: number;   // Alert if treasury accumulates >X USD

  // IBR monitoring
  ibrEndingInHours: number;           // Alert X hours before IBR ends

  // Pause monitoring
  pausedDurationHours: number;        // Alert if paused >X hours
}

export interface MonitoringConfig {
  network: string;
  chainId: number;
  rpcUrl: string;
  backupRpcUrl?: string;

  contracts: ContractAddresses;
  initialPools: PoolConfig[];

  thresholds: AlertThresholds;

  // Polling configuration
  statePollingIntervalMs: number;     // How often to poll pool state (12s = 1 block)
  eventPollingFromBlock: number | 'latest';

  // Alert configuration
  alertEmail: string;
  awsSesRegion: string;

  // Monitoring toggles
  enabled: boolean;
  poolDiscoveryEnabled: boolean;      // Auto-discover new pools
  eventListenersEnabled: boolean;     // Listen for blockchain events
  statePollingEnabled: boolean;       // Poll pool state
  alertsEnabled: boolean;             // Send alerts
}

/**
 * Default alert thresholds (based on monitoring-requirements.md)
 */
export const DEFAULT_THRESHOLDS: AlertThresholds = {
  minReserveUSD: 1000,
  reserveDropPercentage: 20,
  reserveDropWindowMs: 60 * 60 * 1000, // 1 hour

  priceChange1hPercentage: 20,
  priceChange24hPercentage: 50,

  largeTradeUSD: 10000,

  supplyChange1hPercentage: 15,

  highGasGwei: 200,
  extremeGasGwei: 500,

  treasuryFeesThresholdUSD: 50000,

  ibrEndingInHours: 24,

  pausedDurationHours: 1
};

/**
 * Load deployment configuration from file
 */
export function loadDeploymentConfig(network: string): { contracts: ContractAddresses, pools: PoolConfig[] } {
  try {
    const deploymentPath = join(process.cwd(), '..', '..', 'deployments', `${network}-latest.json`);
    const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));

    return {
      contracts: {
        modelRegistry: deployment.contracts.ModelRegistry,
        tokenManager: deployment.contracts.TokenManager,
        hokusaiParams: deployment.contracts.HokusaiParams,
        ammFactory: deployment.contracts.HokusaiAMMFactory,
        usageFeeRouter: deployment.contracts.UsageFeeRouter,
        deltaVerifier: deployment.contracts.DeltaVerifier,
        usdc: deployment.config?.usdcAddress || deployment.contracts.MockUSDC || deployment.contracts.USDC
      },
      pools: deployment.pools || []
    };
  } catch (error) {
    throw new Error(`Failed to load deployment config for ${network}: ${error}`);
  }
}

/**
 * Create monitoring configuration from environment
 */
export function createMonitoringConfig(): MonitoringConfig {
  const network = process.env.NETWORK || 'mainnet';
  const chainId = network === 'mainnet' ? 1 : 11155111; // Sepolia

  // Load contract addresses and pools from deployment artifact
  const { contracts, pools } = loadDeploymentConfig(network);

  // Build configuration
  const config: MonitoringConfig = {
    network,
    chainId,
    rpcUrl: process.env.MAINNET_RPC_URL || process.env.SEPOLIA_RPC_URL || '',
    backupRpcUrl: process.env.BACKUP_RPC_URL,

    contracts,
    initialPools: pools,

    thresholds: {
      minReserveUSD: parseFloat(process.env.ALERT_RESERVE_MIN_USD || String(DEFAULT_THRESHOLDS.minReserveUSD)),
      reserveDropPercentage: parseFloat(process.env.ALERT_RESERVE_DROP_PCT || String(DEFAULT_THRESHOLDS.reserveDropPercentage)),
      reserveDropWindowMs: DEFAULT_THRESHOLDS.reserveDropWindowMs,

      priceChange1hPercentage: parseFloat(process.env.ALERT_PRICE_CHANGE_1H_PCT || String(DEFAULT_THRESHOLDS.priceChange1hPercentage)),
      priceChange24hPercentage: parseFloat(process.env.ALERT_PRICE_CHANGE_24H_PCT || String(DEFAULT_THRESHOLDS.priceChange24hPercentage)),

      largeTradeUSD: parseFloat(process.env.ALERT_LARGE_TRADE_USD || String(DEFAULT_THRESHOLDS.largeTradeUSD)),

      supplyChange1hPercentage: parseFloat(process.env.ALERT_SUPPLY_CHANGE_1H_PCT || String(DEFAULT_THRESHOLDS.supplyChange1hPercentage)),

      highGasGwei: parseFloat(process.env.ALERT_HIGH_GAS_GWEI || String(DEFAULT_THRESHOLDS.highGasGwei)),
      extremeGasGwei: parseFloat(process.env.ALERT_EXTREME_GAS_GWEI || String(DEFAULT_THRESHOLDS.extremeGasGwei)),

      treasuryFeesThresholdUSD: parseFloat(process.env.ALERT_TREASURY_FEES_USD || String(DEFAULT_THRESHOLDS.treasuryFeesThresholdUSD)),

      ibrEndingInHours: parseFloat(process.env.ALERT_IBR_ENDING_HOURS || String(DEFAULT_THRESHOLDS.ibrEndingInHours)),

      pausedDurationHours: parseFloat(process.env.ALERT_PAUSED_DURATION_HOURS || String(DEFAULT_THRESHOLDS.pausedDurationHours))
    },

    statePollingIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS || '12000'), // 12 seconds = 1 block
    eventPollingFromBlock: process.env.MONITORING_START_BLOCK === 'latest' ? 'latest' :
                           parseInt(process.env.MONITORING_START_BLOCK || 'latest'),

    alertEmail: process.env.ALERT_EMAIL || '',
    awsSesRegion: process.env.AWS_SES_REGION || 'us-east-1',

    enabled: process.env.MONITORING_ENABLED !== 'false',
    poolDiscoveryEnabled: process.env.POOL_DISCOVERY_ENABLED !== 'false',
    eventListenersEnabled: process.env.EVENT_LISTENERS_ENABLED !== 'false',
    statePollingEnabled: process.env.STATE_POLLING_ENABLED !== 'false',
    alertsEnabled: process.env.ALERTS_ENABLED !== 'false'
  };

  // Validate configuration
  validateMonitoringConfig(config);

  return config;
}

/**
 * Validate monitoring configuration
 */
function validateMonitoringConfig(config: MonitoringConfig): void {
  const errors: string[] = [];

  if (!config.rpcUrl) {
    errors.push('RPC URL is required (MAINNET_RPC_URL or SEPOLIA_RPC_URL)');
  }

  if (!ethers.isAddress(config.contracts.modelRegistry)) {
    errors.push('Invalid ModelRegistry address');
  }

  if (!ethers.isAddress(config.contracts.tokenManager)) {
    errors.push('Invalid TokenManager address');
  }

  if (!ethers.isAddress(config.contracts.ammFactory)) {
    errors.push('Invalid AMMFactory address');
  }

  if (!ethers.isAddress(config.contracts.usdc)) {
    errors.push('Invalid USDC address');
  }

  if (config.alertsEnabled && !config.alertEmail) {
    errors.push('Alert email is required when alerts are enabled (ALERT_EMAIL)');
  }

  if (config.statePollingIntervalMs < 1000) {
    errors.push('State polling interval must be at least 1000ms');
  }

  if (errors.length > 0) {
    throw new Error(`Monitoring configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * Get human-readable configuration summary
 */
export function getConfigSummary(config: MonitoringConfig): string {
  return `
Monitoring Configuration
========================
Network:        ${config.network} (Chain ID: ${config.chainId})
RPC:            ${config.rpcUrl.substring(0, 50)}...
Backup RPC:     ${config.backupRpcUrl ? 'Configured' : 'None'}

Contracts:
  ModelRegistry:    ${config.contracts.modelRegistry}
  TokenManager:     ${config.contracts.tokenManager}
  AMMFactory:       ${config.contracts.ammFactory}
  UsageFeeRouter:   ${config.contracts.usageFeeRouter}
  USDC:             ${config.contracts.usdc}

Initial Pools:    ${config.initialPools.length} pools
  ${config.initialPools.map(p => `- ${p.modelId}: ${p.ammAddress}`).join('\n  ')}

Alert Thresholds:
  Reserve Drop:     >${config.thresholds.reserveDropPercentage}% in 1h
  Price Change:     >${config.thresholds.priceChange1hPercentage}% in 1h
  Large Trade:      >$${config.thresholds.largeTradeUSD.toLocaleString()}
  Min Reserve:      $${config.thresholds.minReserveUSD.toLocaleString()}

Polling:
  State Interval:   ${config.statePollingIntervalMs}ms (${config.statePollingIntervalMs / 1000}s)
  Event From Block: ${config.eventPollingFromBlock}

Alerts:
  Email:            ${config.alertEmail}
  AWS SES Region:   ${config.awsSesRegion}

Features:
  Monitoring:       ${config.enabled ? 'ENABLED' : 'DISABLED'}
  Pool Discovery:   ${config.poolDiscoveryEnabled ? 'ENABLED' : 'DISABLED'}
  Event Listeners:  ${config.eventListenersEnabled ? 'ENABLED' : 'DISABLED'}
  State Polling:    ${config.statePollingEnabled ? 'ENABLED' : 'DISABLED'}
  Alerts:           ${config.alertsEnabled ? 'ENABLED' : 'DISABLED'}
========================
`;
}
