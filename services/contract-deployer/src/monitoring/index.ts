/**
 * Hokusai AMM Monitoring
 *
 * Real-time monitoring system for Hokusai AMM pools
 */

// Main orchestrator
export { AMMMonitor, AMMMonitorHealth } from './amm-monitor';

// Components
export { PoolDiscovery, PoolDiscoveredCallback } from './pool-discovery';
export { StateTracker, PoolState, StateAlert } from './state-tracker';
export {
  EventListener,
  TradeEvent,
  SecurityEvent,
  FeeEvent,
  EventAlert
} from './event-listener';
export {
  MetricsCollector,
  PoolMetrics,
  SystemMetrics
} from './metrics-collector';
export {
  AlertManager,
  AlertManagerConfig
} from './alert-manager';

// Configuration
export {
  MonitoringConfig,
  ContractAddresses,
  PoolConfig,
  AlertThresholds,
  createMonitoringConfig,
  loadDeploymentConfig,
  getConfigSummary,
  DEFAULT_THRESHOLDS
} from '../config/monitoring-config';

// Health check (existing)
export { HealthCheckService } from './health-check';
