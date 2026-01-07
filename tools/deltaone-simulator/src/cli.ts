/**
 * CLI utilities and formatting
 */

import { SimulationResult, ExecutionResult, ErrorResult } from './types';

export function printBanner() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          Hokusai DeltaOne Simulator v1.0.0              ║');
  console.log('║    Simulate and execute ML model performance rewards    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
}

export function printUsage() {
  console.log('Usage:');
  console.log('  npm run simulate -- <evaluation-file.json> [model-id]');
  console.log('  npm run execute -- <evaluation-file.json> [model-id]');
  console.log('  npm run estimate-gas -- <evaluation-file.json> [model-id]');
  console.log('');
  console.log('Commands:');
  console.log('  simulate      Calculate rewards without spending gas (read-only)');
  console.log('  execute       Actually mint tokens on Sepolia testnet (costs gas)');
  console.log('  estimate-gas  Preview gas costs before executing');
  console.log('');
  console.log('Examples:');
  console.log('  npm run simulate -- examples/sample-evaluation.json model-123');
  console.log('  npm run simulate -- examples/high-improvement.json demo-model');
  console.log('  npm run execute -- examples/sample-evaluation.json model-123');
  console.log('');
  console.log('Available example files:');
  console.log('  sample-evaluation.json           Standard 3.86% improvement');
  console.log('  high-improvement.json            Large 22.11% improvement');
  console.log('  low-improvement.json             Small 0.5% improvement');
  console.log('  edge-case-no-improvement.json    Zero improvement (error case)');
  console.log('  edge-case-partial-improvement.json  Below 1% threshold');
  console.log('  multi-contributor-scenario.json  Multiple contributors (33% weight)');
  console.log('');
  console.log('Environment variables:');
  console.log('  SEPOLIA_PRIVATE_KEY  Required for execute command');
  console.log('                       Get Sepolia ETH from: https://sepoliafaucet.com/');
  console.log('');
  console.log('For more information, see README.md');
}

export function printSimulationHeader(modelId: string, pipelineRunId: string, contributor: string) {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ Simulation Parameters                                   │');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│ Model ID:       ${modelId.padEnd(40)} │`);
  console.log(`│ Pipeline Run:   ${pipelineRunId.padEnd(40)} │`);
  console.log(`│ Contributor:    ${contributor.substring(0, 38).padEnd(40)} │`);
  console.log('└─────────────────────────────────────────────────────────┘');
  console.log('');
}

export function printSimulationSummary(result: SimulationResult) {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ Simulation Results                                      │');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│ DeltaOne Score:    ${result.simulation.deltaOnePercentage.padEnd(36)} │`);
  console.log(`│ Reward Amount:     ${result.simulation.rewardFormatted.padEnd(36)} │`);
  console.log(`│ Status:            ${result.status.toUpperCase().padEnd(36)} │`);
  console.log('└─────────────────────────────────────────────────────────┘');
  console.log('');
}

export function printExecutionSummary(result: ExecutionResult) {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ Execution Results                                       │');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│ Status:         ${result.execution.status.toUpperCase().padEnd(40)} │`);
  console.log(`│ Tokens Minted:  ${result.execution.tokensMinted.padEnd(40)} │`);
  console.log(`│ Gas Used:       ${result.execution.gasUsed.padEnd(40)} │`);
  console.log(`│ Block Number:   ${result.execution.blockNumber.toString().padEnd(40)} │`);
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│ Transaction:    ${result.execution.txHash.substring(0, 38).padEnd(40)} │`);
  console.log(`│ Explorer:       ${shortenUrl(result.execution.explorerUrl).padEnd(40)} │`);
  console.log('└─────────────────────────────────────────────────────────┘');
  console.log('');
}

export function printError(result: ErrorResult) {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ ❌ Error                                                 │');
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│ Code:    ${result.error.code.padEnd(47)} │`);
  console.log(`│ Message: ${wrapText(result.error.message, 47).join('\n│          ')} │`);
  console.log('└─────────────────────────────────────────────────────────┘');
  console.log('');
}

export function printMetricsBreakdown(breakdown: any) {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ Per-Metric Improvements                                 │');
  console.log('├─────────────┬──────────┬──────────┬────────────────────┤');
  console.log('│ Metric      │ Baseline │ New      │ Improvement        │');
  console.log('├─────────────┼──────────┼──────────┼────────────────────┤');
  printMetricRow('Accuracy', breakdown.accuracy);
  printMetricRow('Precision', breakdown.precision);
  printMetricRow('Recall', breakdown.recall);
  printMetricRow('F1 Score', breakdown.f1);
  printMetricRow('AUROC', breakdown.auroc);
  console.log('└─────────────┴──────────┴──────────┴────────────────────┘');
  console.log('');
}

function printMetricRow(name: string, metric: any) {
  const baseline = `${metric.baseline}%`;
  const newVal = `${metric.new}%`;
  const improvement = metric.improvement >= 0
    ? `+${metric.improvement}%`
    : `${metric.improvement}%`;
  const improvementColor = metric.improvement > 0 ? '✓' : metric.improvement < 0 ? '✗' : '−';

  console.log(
    `│ ${name.padEnd(11)} │ ${baseline.padStart(8)} │ ${newVal.padStart(8)} │ ${improvementColor} ${improvement.padStart(16)} │`
  );
}

function shortenUrl(url: string): string {
  if (url.length <= 40) return url;
  return url.substring(0, 37) + '...';
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + word).length <= width) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [text.substring(0, width)];
}
