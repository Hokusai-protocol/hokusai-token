# Frontend Integration Guide

This guide shows how to integrate the DeltaOne simulator into a React frontend for the hokus.ai website.

## Table of Contents

1. [Overview](#overview)
2. [Browser-Native Implementation](#browser-native-implementation)
3. [React Component Examples](#react-component-examples)
4. [MetaMask Integration](#metamask-integration)
5. [Error Handling](#error-handling)
6. [TypeScript Types](#typescript-types)

---

## Overview

The DeltaOne simulator can be ported to run directly in the browser using ethers.js. This allows:

- ✅ **Simulation**: Free, read-only calculations (no wallet needed)
- ✅ **Execution**: Actual token minting via MetaMask (requires user wallet)
- ✅ **Gas Estimation**: Preview costs before executing

**Target Page**: `/explore-models/1/chest-x-ray-diagnostic-v2`

---

## Browser-Native Implementation

### Installation

```bash
npm install ethers@6
```

### Configuration

```typescript
// config/contracts.ts
export const SEPOLIA_CONFIG = {
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  deltaVerifierAddress: '0xbE661fA444A14D87c9e9f20BcC6eaf5fCAF525Bd',
  tokenManagerAddress: '0xEb81526f1D2c4226cEea08821553f6c8a9c1B431',
  network: 'sepolia' as const
};

// Import ABIs (copy from tools/deltaone-simulator/abis/)
import DeltaVerifierABI from './abis/DeltaVerifier.json';
```

### Core Simulator Class

```typescript
// lib/deltaone-simulator.ts
import { ethers } from 'ethers';
import { SEPOLIA_CONFIG } from '@/config/contracts';
import DeltaVerifierABI from '@/config/abis/DeltaVerifier.json';

export interface Metrics {
  accuracy: number;   // In basis points (10000 = 100%)
  precision: number;
  recall: number;
  f1: number;
  auroc: number;
}

export interface EvaluationData {
  pipelineRunId: string;
  baselineMetrics: Metrics;
  newMetrics: Metrics;
  contributor: string;
  contributorWeight: number;  // In basis points
  contributedSamples: number;
  totalSamples: number;
}

export interface SimulationResult {
  deltaOneScore: number;
  deltaOnePercentage: string;
  rewardAmount: string;
  rewardFormatted: string;
  breakdown: {
    accuracy: { baseline: number; new: number; improvement: number };
    precision: { baseline: number; new: number; improvement: number };
    recall: { baseline: number; new: number; improvement: number };
    f1: { baseline: number; new: number; improvement: number };
    auroc: { baseline: number; new: number; improvement: number };
  };
}

export class DeltaOneSimulator {
  private provider: ethers.Provider;
  private deltaVerifier: ethers.Contract;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(SEPOLIA_CONFIG.rpcUrl);
    this.deltaVerifier = new ethers.Contract(
      SEPOLIA_CONFIG.deltaVerifierAddress,
      DeltaVerifierABI.abi,
      this.provider
    );
  }

  /**
   * Simulate DeltaOne calculation (free, no wallet needed)
   */
  async simulate(
    modelId: string,
    evaluationData: EvaluationData
  ): Promise<SimulationResult> {
    try {
      // Step 1: Calculate DeltaOne score
      const deltaOneScore = await this.deltaVerifier.calculateDeltaOne(
        evaluationData.baselineMetrics,
        evaluationData.newMetrics
      );

      // Step 2: Calculate reward
      const rewardAmount = await this.calculateReward(
        modelId,
        deltaOneScore,
        evaluationData
      );

      // Step 3: Format results
      return this.formatResults(
        Number(deltaOneScore),
        rewardAmount,
        evaluationData
      );
    } catch (error: any) {
      throw new Error(`Simulation failed: ${error.message}`);
    }
  }

  private async calculateReward(
    modelId: string,
    deltaScore: bigint,
    evaluationData: EvaluationData
  ): Promise<bigint> {
    try {
      // Try dynamic calculation (requires deployed token)
      return await this.deltaVerifier.calculateRewardDynamic(
        modelId,
        deltaScore,
        evaluationData.contributorWeight,
        evaluationData.contributedSamples
      );
    } catch {
      // Fallback to static calculation
      return await this.deltaVerifier.calculateReward(
        deltaScore,
        evaluationData.contributorWeight,
        evaluationData.contributedSamples
      );
    }
  }

  private formatResults(
    deltaOneScore: number,
    rewardAmount: bigint,
    evaluationData: EvaluationData
  ): SimulationResult {
    const deltaPercentage = (deltaOneScore / 100).toFixed(2);
    const reward = Number(rewardAmount);

    return {
      deltaOneScore,
      deltaOnePercentage: `${deltaPercentage}%`,
      rewardAmount: reward.toFixed(2),
      rewardFormatted: `${reward.toLocaleString('en-US', { minimumFractionDigits: 2 })} tokens`,
      breakdown: this.createBreakdown(
        evaluationData.baselineMetrics,
        evaluationData.newMetrics
      )
    };
  }

  private createBreakdown(baseline: Metrics, newMetrics: Metrics) {
    const toPercent = (bps: number) => bps / 100;

    return {
      accuracy: {
        baseline: toPercent(baseline.accuracy),
        new: toPercent(newMetrics.accuracy),
        improvement: toPercent(newMetrics.accuracy - baseline.accuracy)
      },
      precision: {
        baseline: toPercent(baseline.precision),
        new: toPercent(newMetrics.precision),
        improvement: toPercent(newMetrics.precision - baseline.precision)
      },
      recall: {
        baseline: toPercent(baseline.recall),
        new: toPercent(newMetrics.recall),
        improvement: toPercent(newMetrics.recall - baseline.recall)
      },
      f1: {
        baseline: toPercent(baseline.f1),
        new: toPercent(newMetrics.f1),
        improvement: toPercent(newMetrics.f1 - baseline.f1)
      },
      auroc: {
        baseline: toPercent(baseline.auroc),
        new: toPercent(newMetrics.auroc),
        improvement: toPercent(newMetrics.auroc - baseline.auroc)
      }
    };
  }
}
```

---

## React Component Examples

### 1. Simple Simulation Button

```tsx
// components/SimulateButton.tsx
'use client';

import { useState } from 'react';
import { DeltaOneSimulator } from '@/lib/deltaone-simulator';

interface SimulateButtonProps {
  modelId: string;
  evaluationData: any;
}

export function SimulateButton({ modelId, evaluationData }: SimulateButtonProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSimulate = async () => {
    setLoading(true);
    setError(null);

    try {
      const simulator = new DeltaOneSimulator();
      const simulationResult = await simulator.simulate(modelId, evaluationData);
      setResult(simulationResult);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <button
        onClick={handleSimulate}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'Simulating...' : 'Simulate DeltaOne Reward'}
      </button>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded text-red-800">
          Error: {error}
        </div>
      )}

      {result && (
        <div className="p-4 bg-green-50 border border-green-200 rounded">
          <h3 className="font-semibold mb-2">Simulation Results</h3>
          <p>DeltaOne Score: {result.deltaOnePercentage}</p>
          <p>Reward: {result.rewardFormatted}</p>
        </div>
      )}
    </div>
  );
}
```

### 2. Full Simulation Panel with Breakdown

```tsx
// components/DeltaOnePanel.tsx
'use client';

import { useState } from 'react';
import { DeltaOneSimulator, type SimulationResult } from '@/lib/deltaone-simulator';

export function DeltaOnePanel({ modelId, evaluationData }: any) {
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSimulate = async () => {
    setLoading(true);
    try {
      const simulator = new DeltaOneSimulator();
      const res = await simulator.simulate(modelId, evaluationData);
      setResult(res);
    } catch (error) {
      console.error('Simulation error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <h2 className="text-2xl font-bold mb-4">DeltaOne Simulation</h2>

      <button
        onClick={handleSimulate}
        disabled={loading}
        className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 transition"
      >
        {loading ? 'Calculating...' : 'Calculate Potential Reward'}
      </button>

      {result && (
        <div className="mt-6 space-y-4">
          {/* Summary Card */}
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm text-gray-600">DeltaOne Score</p>
                <p className="text-3xl font-bold text-green-700">
                  {result.deltaOnePercentage}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-600">Estimated Reward</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {result.rewardFormatted}
                </p>
              </div>
            </div>
          </div>

          {/* Metrics Breakdown */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-sm font-semibold">Metric</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">Baseline</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">New</th>
                  <th className="px-4 py-2 text-right text-sm font-semibold">Improvement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {Object.entries(result.breakdown).map(([key, metric]) => (
                  <tr key={key} className="hover:bg-gray-50">
                    <td className="px-4 py-3 capitalize">{key}</td>
                    <td className="px-4 py-3 text-right">{metric.baseline.toFixed(1)}%</td>
                    <td className="px-4 py-3 text-right">{metric.new.toFixed(1)}%</td>
                    <td className={`px-4 py-3 text-right font-semibold ${
                      metric.improvement > 0 ? 'text-green-600' :
                      metric.improvement < 0 ? 'text-red-600' : 'text-gray-600'
                    }`}>
                      {metric.improvement > 0 ? '+' : ''}{metric.improvement.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## MetaMask Integration

### Wallet Connection Hook

```typescript
// hooks/useWallet.ts
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

export function useWallet() {
  const [account, setAccount] = useState<string | null>(null);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);

  const connectWallet = async () => {
    if (typeof window.ethereum === 'undefined') {
      throw new Error('MetaMask not installed');
    }

    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await browserProvider.send('eth_requestAccounts', []);

      setProvider(browserProvider);
      setAccount(accounts[0]);

      return accounts[0];
    } catch (error: any) {
      throw new Error(`Failed to connect wallet: ${error.message}`);
    }
  };

  const disconnect = () => {
    setAccount(null);
    setProvider(null);
  };

  useEffect(() => {
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accounts: string[]) => {
        setAccount(accounts[0] || null);
      });
    }
  }, []);

  return { account, provider, connectWallet, disconnect };
}
```

### Execution Component

```tsx
// components/ExecuteButton.tsx
'use client';

import { useState } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '@/hooks/useWallet';
import { SEPOLIA_CONFIG } from '@/config/contracts';
import DeltaVerifierABI from '@/config/abis/DeltaVerifier.json';

export function ExecuteButton({ modelId, evaluationData }: any) {
  const { account, provider, connectWallet } = useWallet();
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  const handleExecute = async () => {
    if (!account) {
      await connectWallet();
      return;
    }

    setLoading(true);
    try {
      const signer = await provider!.getSigner();
      const deltaVerifier = new ethers.Contract(
        SEPOLIA_CONFIG.deltaVerifierAddress,
        DeltaVerifierABI.abi,
        signer
      );

      // Convert string modelId to number if needed
      const modelIdNum = parseInt(modelId) || 0;

      // Submit evaluation
      const tx = await deltaVerifier.submitEvaluation(
        modelIdNum,
        evaluationData
      );

      setTxHash(tx.hash);

      // Wait for confirmation
      await tx.wait();

      alert('Tokens minted successfully!');
    } catch (error: any) {
      alert(`Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleExecute}
        disabled={loading}
        className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
      >
        {!account ? 'Connect Wallet' : loading ? 'Executing...' : 'Mint Tokens on Sepolia'}
      </button>

      {txHash && (
        <p className="mt-2 text-sm">
          Transaction: <a
            href={`https://sepolia.etherscan.io/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline"
          >
            View on Etherscan
          </a>
        </p>
      )}
    </div>
  );
}
```

---

## Error Handling

### Error Types

```typescript
// lib/errors.ts
export class SimulationError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'SimulationError';
  }
}

export const ERROR_MESSAGES = {
  INSUFFICIENT_IMPROVEMENT: 'Performance improvement below 1% threshold',
  MODEL_NOT_FOUND: 'Token not deployed for this model',
  NETWORK_ERROR: 'Failed to connect to Sepolia network',
  WALLET_NOT_CONNECTED: 'Please connect your MetaMask wallet',
  USER_REJECTED: 'Transaction rejected by user',
};
```

### Error Boundary Component

```tsx
// components/ErrorBoundary.tsx
'use client';

import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
          <h2 className="text-xl font-semibold text-red-800 mb-2">
            Something went wrong
          </h2>
          <p className="text-red-600">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

---

## TypeScript Types

### Complete Type Definitions

```typescript
// types/deltaone.ts
export interface Metrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  auroc: number;
}

export interface EvaluationData {
  pipelineRunId: string;
  baselineMetrics: Metrics;
  newMetrics: Metrics;
  contributor: string;
  contributorWeight: number;
  contributedSamples: number;
  totalSamples: number;
}

export interface MetricBreakdown {
  baseline: number;
  new: number;
  improvement: number;
}

export interface SimulationResult {
  deltaOneScore: number;
  deltaOnePercentage: string;
  rewardAmount: string;
  rewardFormatted: string;
  breakdown: {
    accuracy: MetricBreakdown;
    precision: MetricBreakdown;
    recall: MetricBreakdown;
    f1: MetricBreakdown;
    auroc: MetricBreakdown;
  };
}

export interface ExecutionResult extends SimulationResult {
  execution: {
    txHash: string;
    blockNumber: number;
    gasUsed: string;
    status: 'success' | 'failed';
    explorerUrl: string;
  };
}
```

---

## Complete Usage Example

### Model Page Integration

```tsx
// app/explore-models/[id]/[slug]/page.tsx
import { DeltaOnePanel } from '@/components/DeltaOnePanel';
import { ExecuteButton } from '@/components/ExecuteButton';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export default function ModelPage({ params }: { params: { id: string } }) {
  // Example evaluation data (would come from your API)
  const evaluationData = {
    pipelineRunId: 'run_latest',
    baselineMetrics: {
      accuracy: 8540,
      precision: 8270,
      recall: 8870,
      f1: 8390,
      auroc: 9040
    },
    newMetrics: {
      accuracy: 8840,
      precision: 8540,
      recall: 9130,
      f1: 8910,
      auroc: 9350
    },
    contributor: '0x742d35Cc6631C0532925a3b844D35d2be8b6c6dD9',
    contributorWeight: 9100,
    contributedSamples: 5000,
    totalSamples: 55000
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-8">Chest X-Ray Diagnostic v2</h1>

      {/* Model details... */}

      <div className="mt-8 grid gap-6">
        <ErrorBoundary>
          {/* Simulation Panel */}
          <DeltaOnePanel
            modelId={params.id}
            evaluationData={evaluationData}
          />

          {/* Execution Button (Sepolia only) */}
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-sm text-yellow-800 mb-3">
              ⚠️ Testnet only: This will mint tokens on Sepolia testnet
            </p>
            <ExecuteButton
              modelId={params.id}
              evaluationData={evaluationData}
            />
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
}
```

---

## Production Checklist

Before going to production:

- [ ] Remove execution button (or hide behind feature flag)
- [ ] Switch to mainnet configuration
- [ ] Add proper authentication
- [ ] Implement rate limiting
- [ ] Add analytics tracking
- [ ] Test with real model data
- [ ] Validate all metrics are in basis points
- [ ] Add loading skeletons
- [ ] Implement proper error logging
- [ ] Add user feedback mechanisms

---

## Testing

```typescript
// __tests__/deltaone-simulator.test.ts
import { DeltaOneSimulator } from '@/lib/deltaone-simulator';

describe('DeltaOneSimulator', () => {
  it('should simulate successfully', async () => {
    const simulator = new DeltaOneSimulator();

    const result = await simulator.simulate('test-model', {
      pipelineRunId: 'test',
      baselineMetrics: {
        accuracy: 8500,
        precision: 8200,
        recall: 8700,
        f1: 8400,
        auroc: 9000
      },
      newMetrics: {
        accuracy: 8800,
        precision: 8500,
        recall: 9000,
        f1: 8700,
        auroc: 9300
      },
      contributor: '0x742d35Cc6631C0532925a3b844D35d2be8b6c6dD9',
      contributorWeight: 10000,
      contributedSamples: 5000,
      totalSamples: 50000
    });

    expect(result.deltaOneScore).toBeGreaterThan(0);
    expect(result.rewardAmount).toBeTruthy();
  });
});
```

---

## Support

For questions or issues:
- Check the CLI tool README: `tools/deltaone-simulator/README.md`
- Review contract deployments in main README
- Test with examples in `tools/deltaone-simulator/examples/`

Happy integrating! 🚀
