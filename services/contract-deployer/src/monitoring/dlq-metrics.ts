import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
} from '@aws-sdk/client-cloudwatch';
import { classifyFailure } from '../queue/dlq-inspector';
import { logger } from '../utils/logger';

/**
 * Metric names to emit for a dead-lettered mint request (HOK-1698 "failed-tx spikes").
 *
 * Pure + unit-tested. Always emits the aggregate `mint_dlq` — the spike signal: any datapoint means
 * a mint request was permanently abandoned to the DLQ — plus a per-failure-tag metric so operators
 * can see WHY mints are dying without reading the queue (e.g. `mint_dlq_signer_not_attester` is a
 * security-relevant attester misconfig, `mint_dlq_budget_exhausted` is an economic exhaustion).
 *
 * Reuses the DLQ failure taxonomy (classifyFailure) rather than inventing a parallel one, so the
 * metric tags stay in lock-step with dlq-inspector's classification.
 */
export function dlqMetricNames(reason: string): string[] {
  return ['mint_dlq', `mint_dlq_${classifyFailure(reason)}`];
}

export interface DlqMetricsEmitterConfig {
  enabled: boolean;
  /** e.g. "Hokusai/ContractMonitoring" — same namespace the AMM monitor publishes to. */
  namespace: string;
  /** Single Environment dimension value — must match the health-report query. */
  environment: string;
  region?: string;
}

/**
 * Best-effort CloudWatch emitter for relayer dead-letter events (HOK-1698).
 *
 * Mirrors the AMM monitor's AlertManager.emitMetric shape exactly — same namespace, single
 * [Environment] dimension — so the daily health report's collect_anomaly_metrics picks the metrics
 * up with no extra wiring, and they flow on into the mttr evaluation agent. A metric failure is
 * logged and swallowed: emitting a metric must never break the relayer's dead-letter path.
 */
export class DlqMetricsEmitter {
  private readonly cwClient?: CloudWatchClient;
  private readonly config: DlqMetricsEmitterConfig;

  constructor(config: DlqMetricsEmitterConfig) {
    this.config = config;
    if (config.enabled) {
      this.cwClient = new CloudWatchClient({
        region: config.region || process.env.AWS_REGION,
      });
    }
  }

  async recordDeadLetter(reason: string): Promise<void> {
    if (!this.cwClient) {
      return;
    }
    const dimensions = [{ Name: 'Environment', Value: this.config.environment }];
    const timestamp = new Date();
    const metricData: MetricDatum[] = dlqMetricNames(reason).map((metricName) => ({
      MetricName: metricName,
      Value: 1,
      Unit: 'Count',
      Timestamp: timestamp,
      Dimensions: dimensions,
    }));
    try {
      await this.cwClient.send(
        new PutMetricDataCommand({
          Namespace: this.config.namespace,
          MetricData: metricData,
        }),
      );
    } catch (error) {
      logger.error('Failed to emit DLQ CloudWatch metric', { error, reason });
    }
  }
}
