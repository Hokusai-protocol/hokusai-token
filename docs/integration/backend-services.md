# Backend Service Integration Guide

This guide is for server-side engineers integrating ML pipelines, fee collection, and contribution tracking with the Hokusai Token system.

## Table of Contents

- [Fee Collection Flow](#fee-collection-flow)
- [ML Model Verification](#ml-model-verification)
- [Contribution Tracking](#contribution-tracking)
- [Event Monitoring](#event-monitoring)
- [Code Examples](#code-examples)

## Fee Collection Flow

The `UsageFeeRouter` contract enables backend services to deposit API usage fees into AMM pools, which increases token value for model contributors.

### Authentication

All fee deposits require the `FEE_DEPOSITOR_ROLE`:

```typescript
// Check if your backend address has the required role
const FEE_DEPOSITOR_ROLE = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("FEE_DEPOSITOR_ROLE")
);
const hasRole = await feeRouter.hasRole(FEE_DEPOSITOR_ROLE, backendAddress);

if (!hasRole) {
  console.error("Backend service does not have FEE_DEPOSITOR_ROLE");
}
```

To grant the role (admin only):

```typescript
const tx = await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, backendAddress);
await tx.wait();
```

### Single Deposit Pattern

For depositing fees for a single model:

```typescript
import { ethers } from "ethers";

async function depositSingleFee(
  modelId: string,
  usdcAmount: bigint
): Promise<void> {
  // 1. Approve USDC transfer
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
  const approveTx = await usdc.approve(feeRouterAddress, usdcAmount);
  await approveTx.wait();

  // 2. Deposit fee
  const feeRouter = new ethers.Contract(
    feeRouterAddress,
    FEE_ROUTER_ABI,
    signer
  );

  const depositTx = await feeRouter.depositFee(modelId, usdcAmount);
  const receipt = await depositTx.wait();

  console.log(`Fee deposited: ${receipt.hash}`);
}

// Example: Deposit $100 USDC (6 decimals)
await depositSingleFee("model-sentiment-v1", 100_000000n);
```

### Batch Deposit Pattern

For depositing fees to multiple models efficiently:

```typescript
interface FeeDeposit {
  modelId: string;
  amount: bigint;
}

async function depositBatchFees(deposits: FeeDeposit[]): Promise<void> {
  // 1. Calculate total amount
  const totalAmount = deposits.reduce((sum, d) => sum + d.amount, 0n);

  // 2. Approve total USDC
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
  const approveTx = await usdc.approve(feeRouterAddress, totalAmount);
  await approveTx.wait();

  // 3. Prepare batch data
  const modelIds = deposits.map((d) => d.modelId);
  const amounts = deposits.map((d) => d.amount);

  // 4. Execute batch deposit
  const feeRouter = new ethers.Contract(
    feeRouterAddress,
    FEE_ROUTER_ABI,
    signer
  );

  const batchTx = await feeRouter.batchDepositFees(modelIds, amounts);
  const receipt = await batchTx.wait();

  console.log(`Batch deposited ${deposits.length} fees: ${receipt.hash}`);
}

// Example: Deposit to 3 models
await depositBatchFees([
  { modelId: "model-sentiment-v1", amount: 50_000000n },  // $50
  { modelId: "model-forecast-v2", amount: 150_000000n },  // $150
  { modelId: "model-classify-v1", amount: 25_000000n },   // $25
]);
```

### Fee Distribution Logic

When you deposit fees:

1. **Protocol Fee Split**: A percentage (default 5%) goes to the treasury
2. **Pool Deposit**: Remainder increases the AMM reserve
3. **Price Impact**: Spot price increases proportionally

```typescript
// With 5% protocol fee:
// Deposit: $100 USDC
// → Treasury: $5 (protocol fee)
// → Pool Reserve: $95 (increases token value)
```

### Monitoring Deposits

Listen for `FeeDeposited` events to track successful deposits:

```typescript
feeRouter.on(
  "FeeDeposited",
  (
    modelId: string,
    poolAddress: string,
    amount: bigint,
    protocolFee: bigint,
    poolDeposit: bigint,
    depositor: string
  ) => {
    console.log(`Fee deposited for ${modelId}:`);
    console.log(`  Total: ${ethers.formatUnits(amount, 6)} USDC`);
    console.log(`  Protocol Fee: ${ethers.formatUnits(protocolFee, 6)} USDC`);
    console.log(`  Pool Deposit: ${ethers.formatUnits(poolDeposit, 6)} USDC`);

    // Update your database/analytics
    recordFeeDeposit({
      modelId,
      amount: amount.toString(),
      timestamp: Date.now(),
    });
  }
);
```

## ML Model Verification

The `DeltaVerifier` contract validates ML model improvements and mints token rewards to contributors.

### Evaluation Data Structure

```typescript
interface Metrics {
  accuracy: bigint;   // Basis points (8500 = 85%)
  precision: bigint;  // Basis points
  recall: bigint;     // Basis points
  f1: bigint;        // Basis points
  auroc: bigint;     // Basis points
}

interface EvaluationData {
  pipelineRunId: string;
  baselineMetrics: Metrics;
  newMetrics: Metrics;
  contributor: string;           // Ethereum address
  contributorWeight: bigint;     // Basis points (9100 = 91%)
  contributedSamples: bigint;
  totalSamples: bigint;
}
```

### Submitting Evaluations

```typescript
async function submitEvaluation(
  modelId: number,
  evaluation: EvaluationData
): Promise<bigint> {
  const deltaVerifier = new ethers.Contract(
    deltaVerifierAddress,
    DELTA_VERIFIER_ABI,
    signer
  );

  // Submit evaluation (automatically calculates and mints rewards)
  const tx = await deltaVerifier.submitEvaluation(modelId, evaluation);
  const receipt = await tx.wait();

  // Extract reward amount from RewardCalculated event
  const rewardEvent = receipt.logs
    .map((log) => {
      try {
        return deltaVerifier.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e) => e?.name === "RewardCalculated");

  const rewardAmount = rewardEvent?.args.rewardAmount as bigint;
  console.log(`Reward minted: ${ethers.formatEther(rewardAmount)} tokens`);

  return rewardAmount;
}

// Example: Submit evaluation showing 3% improvement
await submitEvaluation(123, {
  pipelineRunId: "run_abc123",
  baselineMetrics: {
    accuracy: 8540n,   // 85.4%
    precision: 8270n,  // 82.7%
    recall: 8870n,     // 88.7%
    f1: 8390n,        // 83.9%
    auroc: 9040n,     // 90.4%
  },
  newMetrics: {
    accuracy: 8840n,   // 88.4% (+3%)
    precision: 8540n,  // 85.4% (+2.7%)
    recall: 9130n,     // 91.3% (+2.6%)
    f1: 8910n,        // 89.1% (+5.2%)
    auroc: 9350n,     // 93.5% (+3.1%)
  },
  contributor: "0x742d35Cc6631C0532925a3b8D756d2bE8b6c6DD9",
  contributorWeight: 9100n,  // 91% attribution
  contributedSamples: 5000n,
  totalSamples: 55000n,
});
```

### Multiple Contributors

For evaluations with multiple contributors:

```typescript
interface Contributor {
  walletAddress: string;
  weight: bigint;  // Basis points, sum must equal 10000
}

async function submitMultiContributorEval(
  modelId: number,
  evaluation: {
    pipelineRunId: string;
    baselineMetrics: Metrics;
    newMetrics: Metrics;
  },
  contributors: Contributor[]
): Promise<void> {
  // Validate weights sum to 100%
  const totalWeight = contributors.reduce((sum, c) => sum + c.weight, 0n);
  if (totalWeight !== 10000n) {
    throw new Error(`Weights must sum to 10000, got ${totalWeight}`);
  }

  const deltaVerifier = new ethers.Contract(
    deltaVerifierAddress,
    DELTA_VERIFIER_ABI,
    signer
  );

  const tx = await deltaVerifier.submitEvaluationWithMultipleContributors(
    modelId,
    evaluation,
    contributors
  );
  await tx.wait();

  console.log(`Rewards distributed to ${contributors.length} contributors`);
}
```

### Reward Calculation Formula

The DeltaVerifier uses this formula:

```
DeltaOne Score = Average % improvement across all metrics
Reward = baseRewardRate × DeltaOne × contributorWeight × (contributedSamples / totalSamples)
```

Example:
- Base reward rate: 1000 tokens per 1% improvement
- DeltaOne: 3.32% (average improvement)
- Contributor weight: 91% (9100 bps)
- Samples: 5000 / 55000 = 9.1%

```
Reward = 1000 × 3.32 × 0.91 × 0.091 = 275 tokens
```

## Contribution Tracking

The `DataContributionRegistry` tracks all data contributions with attribution weights.

### Recording Contributions

Contributions are automatically recorded by DeltaVerifier, but you can query them:

```typescript
async function getContributions(
  modelId: string,
  offset: number = 0,
  limit: number = 100
): Promise<Contribution[]> {
  const registry = new ethers.Contract(
    registryAddress,
    CONTRIBUTION_REGISTRY_ABI,
    provider
  );

  const contributions = await registry.getContributionsByModel(
    modelId,
    offset,
    limit
  );

  return contributions.map((c: any) => ({
    contributor: c.contributor,
    amount: ethers.formatEther(c.amount),
    timestamp: new Date(Number(c.timestamp) * 1000),
    verified: c.verified,
  }));
}

// Get last 50 contributions for a model
const recentContributions = await getContributions("model-sentiment-v1", 0, 50);
```

### Verification Workflow

Backend services with `VERIFIER_ROLE` can verify contributions:

```typescript
async function verifyContribution(contributionId: number): Promise<void> {
  const registry = new ethers.Contract(
    registryAddress,
    CONTRIBUTION_REGISTRY_ABI,
    signer
  );

  const tx = await registry.verifyContribution(contributionId);
  await tx.wait();

  console.log(`Contribution ${contributionId} verified`);
}

async function rejectContribution(
  contributionId: number,
  reason: string
): Promise<void> {
  const registry = new ethers.Contract(
    registryAddress,
    CONTRIBUTION_REGISTRY_ABI,
    signer
  );

  const tx = await registry.rejectContribution(contributionId, reason);
  await tx.wait();

  console.log(`Contribution ${contributionId} rejected: ${reason}`);
}
```

## Event Monitoring

### Critical Events to Monitor

#### FeeDeposited

```typescript
interface FeeDepositedEvent {
  modelId: string;
  poolAddress: string;
  amount: bigint;
  protocolFee: bigint;
  poolDeposit: bigint;
  depositor: string;
}

feeRouter.on(
  "FeeDeposited",
  (modelId, poolAddress, amount, protocolFee, poolDeposit, depositor) => {
    // Update analytics
    updateModelRevenue(modelId, amount);
    trackProtocolFees(protocolFee);
  }
);
```

#### RewardCalculated

```typescript
interface RewardCalculatedEvent {
  contributor: string;
  deltaInBps: bigint;
  rewardAmount: bigint;
}

deltaVerifier.on("RewardCalculated", (contributor, deltaInBps, rewardAmount) => {
  console.log(`Contributor ${contributor}:`);
  console.log(`  Improvement: ${Number(deltaInBps) / 100}%`);
  console.log(`  Reward: ${ethers.formatEther(rewardAmount)} tokens`);

  // Notify contributor
  notifyContributor(contributor, rewardAmount);
});
```

#### ContributionRecorded

```typescript
contributionRegistry.on(
  "ContributionRecorded",
  (contributionId, modelId, contributor, amount, timestamp) => {
    console.log(`New contribution #${contributionId} for ${modelId}`);

    // Update leaderboard
    updateContributorLeaderboard(modelId, contributor, amount);
  }
);
```

### Event Filtering

Filter events by specific parameters:

```typescript
// Get all fees deposited for a specific model
const filter = feeRouter.filters.FeeDeposited("model-sentiment-v1");
const events = await feeRouter.queryFilter(filter, fromBlock, toBlock);

// Get all rewards for a specific contributor
const rewardFilter = deltaVerifier.filters.RewardCalculated(contributorAddress);
const rewards = await deltaVerifier.queryFilter(rewardFilter);
```

### Handling Reorgs

For mission-critical operations, wait for confirmations:

```typescript
async function depositFeeWithConfirmations(
  modelId: string,
  amount: bigint,
  requiredConfirmations: number = 3
): Promise<void> {
  const tx = await feeRouter.depositFee(modelId, amount);

  console.log(`Transaction sent: ${tx.hash}`);

  // Wait for confirmations
  const receipt = await tx.wait(requiredConfirmations);

  console.log(`Confirmed with ${requiredConfirmations} blocks`);
}
```

## Code Examples

### Complete Fee Collection Service

```typescript
import { ethers } from "ethers";

class FeeCollectionService {
  private feeRouter: ethers.Contract;
  private usdc: ethers.Contract;
  private signer: ethers.Signer;

  constructor(
    feeRouterAddress: string,
    usdcAddress: string,
    signer: ethers.Signer
  ) {
    this.feeRouter = new ethers.Contract(
      feeRouterAddress,
      FEE_ROUTER_ABI,
      signer
    );
    this.usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
    this.signer = signer;
  }

  async depositFees(modelId: string, usdcAmount: bigint): Promise<string> {
    // Check balance
    const balance = await this.usdc.balanceOf(await this.signer.getAddress());
    if (balance < usdcAmount) {
      throw new Error("Insufficient USDC balance");
    }

    // Approve
    const approveTx = await this.usdc.approve(
      await this.feeRouter.getAddress(),
      usdcAmount
    );
    await approveTx.wait();

    // Deposit
    const depositTx = await this.feeRouter.depositFee(modelId, usdcAmount);
    const receipt = await depositTx.wait();

    return receipt.hash;
  }

  async batchDeposit(
    deposits: Array<{ modelId: string; amount: bigint }>
  ): Promise<string> {
    const totalAmount = deposits.reduce((sum, d) => sum + d.amount, 0n);

    // Approve total
    const approveTx = await this.usdc.approve(
      await this.feeRouter.getAddress(),
      totalAmount
    );
    await approveTx.wait();

    // Batch deposit
    const modelIds = deposits.map((d) => d.modelId);
    const amounts = deposits.map((d) => d.amount);

    const batchTx = await this.feeRouter.batchDepositFees(modelIds, amounts);
    const receipt = await batchTx.wait();

    return receipt.hash;
  }

  async getDepositHistory(
    modelId: string,
    fromBlock: number = 0
  ): Promise<FeeDepositedEvent[]> {
    const filter = this.feeRouter.filters.FeeDeposited(modelId);
    const events = await this.feeRouter.queryFilter(filter, fromBlock);

    return events.map((e) => ({
      modelId: e.args.modelId,
      poolAddress: e.args.poolAddress,
      amount: e.args.amount,
      protocolFee: e.args.protocolFee,
      poolDeposit: e.args.poolDeposit,
      depositor: e.args.depositor,
    }));
  }
}

// Usage
const service = new FeeCollectionService(
  feeRouterAddress,
  usdcAddress,
  signer
);

// Single deposit
await service.depositFees("model-sentiment-v1", 100_000000n);

// Batch deposit
await service.batchDeposit([
  { modelId: "model-sentiment-v1", amount: 50_000000n },
  { modelId: "model-forecast-v2", amount: 150_000000n },
]);
```

See [docs/examples/typescript/fee-collection.ts](../examples/typescript/fee-collection.ts) for the complete implementation.

### Event Monitoring Service

See [docs/examples/typescript/event-monitoring.ts](../examples/typescript/event-monitoring.ts) for a production-ready event monitoring service.

### ML Verification Integration

See [docs/examples/typescript/ml-verification.ts](../examples/typescript/ml-verification.ts) for complete ML pipeline integration.

## Best Practices

### Error Handling

Always handle common errors:

```typescript
try {
  await feeRouter.depositFee(modelId, amount);
} catch (error: any) {
  if (error.message.includes("Pool does not exist")) {
    console.error(`No pool for model ${modelId}`);
  } else if (error.message.includes("Amount must be > 0")) {
    console.error("Invalid amount");
  } else if (error.message.includes("Transfer failed")) {
    console.error("Insufficient USDC allowance or balance");
  } else {
    throw error;
  }
}
```

### Gas Optimization

- Use batch operations when possible
- Monitor gas prices and delay non-urgent transactions
- Set appropriate gas limits to avoid failures

```typescript
// Set gas limit and price
const tx = await feeRouter.depositFee(modelId, amount, {
  gasLimit: 200000,
  maxFeePerGas: ethers.parseUnits("50", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
});
```

### Rate Limiting

DeltaVerifier has built-in rate limiting (1 hour between submissions per address). Handle this gracefully:

```typescript
try {
  await deltaVerifier.submitEvaluation(modelId, evaluation);
} catch (error: any) {
  if (error.message.includes("Rate limit exceeded")) {
    const nextSubmission = Date.now() + 3600000; // 1 hour
    console.log(`Rate limited. Next submission: ${new Date(nextSubmission)}`);
    scheduleRetry(evaluation, nextSubmission);
  }
}
```

## Next Steps

- [Frontend Integration Guide](./frontend-development.md) - Build UIs for trading and analytics
- [Troubleshooting Guide](../troubleshooting.md) - Common errors and solutions
- [API Reference: UsageFeeRouter](../api-reference/contracts/UsageFeeRouter.md) - Full contract documentation
- [API Reference: DeltaVerifier](../api-reference/contracts/DeltaVerifier.md) - Verification contract reference
