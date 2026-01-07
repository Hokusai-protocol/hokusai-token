/**
 * Formatting utilities for simulation output
 */

import { Metrics, MetricBreakdown } from './types';

/**
 * Convert basis points to percentage (8540 -> 85.4)
 */
export function bpsToPercentage(bps: number): number {
  return bps / 100;
}

/**
 * Format number with thousands separators (3521.7 -> "3,521.70")
 */
export function formatWithCommas(value: number, decimals: number = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

/**
 * Format percentage from basis points (387 -> "3.87%")
 */
export function formatPercentage(bps: number, decimals: number = 2): string {
  const percentage = bps / 100;
  return `${percentage.toFixed(decimals)}%`;
}

/**
 * Calculate improvement between two metric values in basis points
 */
export function calculateImprovement(baseline: number, newValue: number): number {
  return newValue - baseline;
}

/**
 * Create metric breakdown object
 */
export function createMetricBreakdown(
  baseline: number,
  newValue: number
): MetricBreakdown {
  const baselinePercent = bpsToPercentage(baseline);
  const newPercent = bpsToPercentage(newValue);
  const improvement = bpsToPercentage(newValue - baseline);

  return {
    baseline: parseFloat(baselinePercent.toFixed(1)),
    new: parseFloat(newPercent.toFixed(1)),
    improvement: parseFloat(improvement.toFixed(1))
  };
}

/**
 * Create breakdown for all metrics
 */
export function createMetricsBreakdown(
  baselineMetrics: Metrics,
  newMetrics: Metrics
) {
  return {
    accuracy: createMetricBreakdown(baselineMetrics.accuracy, newMetrics.accuracy),
    precision: createMetricBreakdown(baselineMetrics.precision, newMetrics.precision),
    recall: createMetricBreakdown(baselineMetrics.recall, newMetrics.recall),
    f1: createMetricBreakdown(baselineMetrics.f1, newMetrics.f1),
    auroc: createMetricBreakdown(baselineMetrics.auroc, newMetrics.auroc)
  };
}

/**
 * Format token amount (already in token units, not wei)
 */
export function formatTokenAmount(tokenAmount: bigint): string {
  const amount = Number(tokenAmount);
  return amount.toFixed(2);
}

/**
 * Format token amount with commas
 */
export function formatTokenAmountWithCommas(tokenAmount: bigint): string {
  const amount = formatTokenAmount(tokenAmount);
  return `${formatWithCommas(parseFloat(amount))} tokens`;
}
