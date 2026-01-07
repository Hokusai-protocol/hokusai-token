/**
 * DeltaOne Simulator - Main entry point
 */

import { Simulator } from './simulator';
import { Executor } from './executor';
import { SimulatorConfig, ExecutorConfig, EvaluationData } from './types';
import {
  printBanner,
  printUsage as printCLIUsage,
  printSimulationHeader,
  printSimulationSummary,
  printExecutionSummary,
  printError,
  printMetricsBreakdown
} from './cli';
import * as fs from 'fs';
import * as path from 'path';

// Sepolia configuration
const SEPOLIA_CONFIG: SimulatorConfig = {
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  deltaVerifierAddress: '0xbE661fA444A14D87c9e9f20BcC6eaf5fCAF525Bd',
  tokenManagerAddress: '0xEb81526f1D2c4226cEea08821553f6c8a9c1B431',
  network: 'sepolia'
};

async function main() {
  const args = process.argv.slice(2);

  // Parse command
  let command = 'simulate';
  let startIndex = 0;

  if (args[0] === 'simulate' || args[0] === 'execute' || args[0] === 'estimate-gas') {
    command = args[0];
    startIndex = 1;
  }

  if (args.length <= startIndex) {
    printCLIUsage();
    process.exit(1);
  }

  const evaluationFile = args[startIndex];
  const modelId = args[startIndex + 1] || 'model-123';

  // Load evaluation data
  const evaluationPath = path.resolve(evaluationFile);
  if (!fs.existsSync(evaluationPath)) {
    console.error(`Error: File not found: ${evaluationPath}`);
    process.exit(1);
  }

  const evaluationData: EvaluationData = JSON.parse(
    fs.readFileSync(evaluationPath, 'utf-8')
  );

  // Execute command
  if (command === 'simulate') {
    await runSimulation(modelId, evaluationData);
  } else if (command === 'execute') {
    await runExecution(modelId, evaluationData);
  } else if (command === 'estimate-gas') {
    await runGasEstimate(modelId, evaluationData);
  }
}

async function runSimulation(modelId: string, evaluationData: EvaluationData) {
  printBanner();
  console.log('🔄 Starting DeltaOne simulation...\n');
  printSimulationHeader(modelId, evaluationData.pipelineRunId, evaluationData.contributor);

  const simulator = new Simulator(SEPOLIA_CONFIG);
  const result = await simulator.simulate(modelId, evaluationData);

  if (result.status === 'error') {
    printError(result as any);
    console.log('\n📋 Full Error Details:\n');
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  printSimulationSummary(result as any);
  printMetricsBreakdown((result as any).simulation.breakdown);

  console.log('📊 Full JSON Output:\n');
  console.log(JSON.stringify(result, null, 2));
}

async function runExecution(modelId: string, evaluationData: EvaluationData) {
  printBanner();
  console.log('🚀 Starting DeltaOne execution on Sepolia...\n');
  printSimulationHeader(modelId, evaluationData.pipelineRunId, evaluationData.contributor);

  // Get private key from environment
  const privateKey = process.env.SEPOLIA_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ Error: SEPOLIA_PRIVATE_KEY environment variable not set');
    console.error('Set it with: export SEPOLIA_PRIVATE_KEY=0x...');
    console.error('\nGet Sepolia ETH from: https://sepoliafaucet.com/');
    process.exit(1);
  }

  const executorConfig: ExecutorConfig = {
    ...SEPOLIA_CONFIG,
    privateKey
  };

  const executor = new Executor(executorConfig);
  const result = await executor.execute(modelId, evaluationData);

  if (result.status === 'error') {
    printError(result as any);
    console.log('\n📋 Full Error Details:\n');
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  printSimulationSummary(result as any);
  printMetricsBreakdown((result as any).simulation.breakdown);
  printExecutionSummary(result as any);

  console.log('📊 Full JSON Output:\n');
  console.log(JSON.stringify(result, null, 2));
}

async function runGasEstimate(modelId: string, evaluationData: EvaluationData) {
  console.log('⛽ Estimating gas cost...\n');
  console.log(`Model ID: ${modelId}`);
  console.log(`Pipeline Run: ${evaluationData.pipelineRunId}`);

  const privateKey = process.env.SEPOLIA_PRIVATE_KEY || '0x' + '0'.repeat(64);

  const executorConfig: ExecutorConfig = {
    ...SEPOLIA_CONFIG,
    privateKey
  };

  const executor = new Executor(executorConfig);

  try {
    const gasInfo = await executor.estimateGas(modelId, evaluationData);

    console.log('\nGas Estimate:');
    console.log(`  Gas units: ${gasInfo.gasEstimate.toString()}`);
    console.log(`  Gas price: ${gasInfo.gasPrice.toString()} wei`);
    console.log(`  Estimated cost: ${gasInfo.estimatedCost} ETH`);
  } catch (error: any) {
    console.error('\n❌ Error estimating gas:', error.message);
    process.exit(1);
  }
}


main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
