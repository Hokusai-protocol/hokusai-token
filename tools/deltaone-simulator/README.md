# DeltaOne Simulator

A tool for simulating and executing DeltaOne token minting on the Hokusai platform.

## Features

- ✅ **Simulation Mode**: Calculate rewards without spending gas (read-only)
- ✅ **Execution Mode**: Actually mint tokens on Sepolia testnet
- ✅ **Gas Estimation**: Preview costs before executing
- ✅ **Structured JSON Output**: Easy integration with frontends
- ✅ **Detailed Breakdown**: Per-metric improvements and parameters

## Installation

```bash
npm install
```

## Configuration

### For Simulation (No wallet needed)
No configuration required! Simulations use public RPC endpoints.

### For Execution (Requires Sepolia testnet wallet)

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Add your Sepolia private key to `.env`:
```
SEPOLIA_PRIVATE_KEY=0x...your_private_key_here
```

3. Get Sepolia ETH from a faucet:
   - https://sepoliafaucet.com/
   - https://www.alchemy.com/faucets/ethereum-sepolia

## Usage

### 1. Simulation (Free, no wallet needed)

Calculate what rewards would be without executing:

```bash
npm run simulate -- examples/sample-evaluation.json model-123
```

Output:
```json
{
  "simulation": {
    "deltaOneScore": 386,
    "deltaOnePercentage": "3.86%",
    "rewardAmount": "3512.00",
    "rewardFormatted": "3,512.00 tokens",
    "breakdown": {
      "accuracy": { "baseline": 85.4, "new": 88.4, "improvement": 3.0 },
      ...
    }
  },
  "status": "simulated"
}
```

### 2. Gas Estimation

Preview gas costs before executing:

```bash
npm run estimate-gas -- examples/sample-evaluation.json model-123
```

### 3. Execution (Costs gas, mints tokens)

Actually mint tokens on Sepolia testnet:

```bash
# Set your private key
export SEPOLIA_PRIVATE_KEY=0x...

# Execute
npm run execute -- examples/sample-evaluation.json model-123
```

Output includes both simulation AND execution results:
```json
{
  "simulation": { ... },
  "execution": {
    "txHash": "0xabc...",
    "blockNumber": 12345678,
    "gasUsed": "245823",
    "status": "success",
    "tokensMinted": "3512",
    "recipient": "0x742d...",
    "explorerUrl": "https://sepolia.etherscan.io/tx/0xabc..."
  },
  "status": "executed"
}
```

## Examples

The `examples/` directory contains sample evaluation data:

- `sample-evaluation.json` - Standard 3.86% improvement
- `high-improvement.json` - Large 22.11% improvement
- `low-improvement.json` - Small 0.5% improvement

Try them all:
```bash
npm run simulate -- examples/high-improvement.json demo-model
npm run simulate -- examples/low-improvement.json demo-model
```

## Creating Your Own Evaluation Data

Create a JSON file with this structure:

```json
{
  "pipelineRunId": "run_abc123",
  "baselineMetrics": {
    "accuracy": 8540,    // 85.40% in basis points
    "precision": 8270,   // 82.70%
    "recall": 8870,      // 88.70%
    "f1": 8390,         // 83.90%
    "auroc": 9040       // 90.40%
  },
  "newMetrics": {
    "accuracy": 8840,    // 88.40% (improved!)
    "precision": 8540,   // 85.40%
    "recall": 9130,      // 91.30%
    "f1": 8910,         // 89.10%
    "auroc": 9350       // 93.50%
  },
  "contributor": "0x742d35Cc6631C0532925a3b844D35d2be8b6c6dD9",
  "contributorWeight": 9100,  // 91.00% in basis points
  "contributedSamples": 5000,
  "totalSamples": 55000
}
```

**Note**: All metrics are in **basis points** (10000 = 100%)

## Deployed Contracts (Sepolia)

- **DeltaVerifier**: `0xbE661fA444A14D87c9e9f20BcC6eaf5fCAF525Bd`
- **TokenManager**: `0xEb81526f1D2c4226cEea08821553f6c8a9c1B431`
- **Network**: Sepolia Testnet
- **Explorer**: https://sepolia.etherscan.io/

## How It Works

### Simulation Flow
1. Connect to Sepolia RPC (read-only, no wallet)
2. Call `calculateDeltaOne()` to get improvement score
3. Call `calculateReward()` to get token amount
4. Format and return JSON result

### Execution Flow
1. Run simulation first (validate improvement)
2. Connect wallet (private key)
3. Estimate gas costs
4. Submit transaction to `DeltaVerifier.submitEvaluation()`
5. Wait for confirmation
6. Parse events to get minted tokens
7. Return combined simulation + execution result

## Error Handling

The tool handles common errors gracefully:

- **Insufficient Improvement**: If DeltaOne < 1%, returns clear error
- **Model Not Found**: Falls back to base reward calculation
- **No Wallet**: Clear instructions to set SEPOLIA_PRIVATE_KEY
- **Network Issues**: Retries with helpful error messages

## Frontend Integration

See `FRONTEND_INTEGRATION.md` (coming in Phase 4) for how to use this tool from a React frontend.

## Development

Build TypeScript:
```bash
npm run build
```

The compiled output will be in `dist/`.

## Troubleshooting

### "Model not found for model"
This is expected for non-deployed models. The tool automatically falls back to base parameters.

### "Insufficient gas"
Get more Sepolia ETH from a faucet.

### "Transaction reverted"
Check that:
- Model ID exists (or use simulation mode)
- Improvement meets 1% minimum threshold
- Wallet has sufficient Sepolia ETH

## License

MIT
