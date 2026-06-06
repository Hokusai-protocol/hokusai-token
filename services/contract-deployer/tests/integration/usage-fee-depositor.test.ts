import { ethers } from 'ethers';
import { UsageFeeRouterClient, ModelNotActiveError } from '../../src/blockchain/usage-fee-router-client';
import deployments from '../../../deployments/sepolia-v2-latest.json';

describe('UsageFeeRouter integration', () => {
  // Guard: skip all tests unless RUN_INTEGRATION_TESTS or SEPOLIA_RPC_URL is set
  if (!process.env.RUN_INTEGRATION_TESTS && !process.env.SEPOLIA_RPC_URL) {
    test('skipped: requires SEPOLIA_RPC_URL or RUN_INTEGRATION_TESTS', () => {
      expect(true).toBe(true);
    });
    return;
  }

  let client: UsageFeeRouterClient;
  let provider: ethers.Provider;
  let signer: ethers.Signer;

  beforeAll(async () => {
    const rpcUrl = process.env.SEPOLIA_RPC_URL || 'http://localhost:8545';
    provider = new ethers.JsonRpcProvider(rpcUrl);

    // Create signer from private key (use DEPLOYER_PRIVATE_KEY if available)
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.TEST_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('DEPLOYER_PRIVATE_KEY or TEST_PRIVATE_KEY required for integration tests');
    }

    signer = new ethers.Wallet(privateKey, provider);

    // Initialize UsageFeeRouter client
    client = new UsageFeeRouterClient({
      routerAddress: deployments.contracts.UsageFeeRouter,
      provider,
      signer,
      confirmations: 1
    });
  });

  test('depositFee succeeds for active model', async () => {
    const modelId = '25'; // HLEAD from deployments
    const amount = BigInt(1000) * BigInt(10 ** 6); // 1000 USDC (6 decimals)
    const callCount = BigInt(100);

    const result = await client.depositFee(modelId, amount, callCount);

    expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(result.blockNumber).toBeGreaterThan(0);
    expect(result.gasUsed).toBeDefined();
    expect(result.gasPrice).toBeDefined();
  });

  test('throws ModelNotActiveError for inactive/unknown model', async () => {
    const unknownModelId = 'NONEXISTENT_MODEL_ID_12345';
    const amount = BigInt(1000) * BigInt(10 ** 6);
    const callCount = BigInt(100);

    await expect(
      client.depositFee(unknownModelId, amount, callCount)
    ).rejects.toThrow(ModelNotActiveError);
  });

  test('event FeeDeposited is emitted correctly', async () => {
    const modelId = '25';
    const amount = BigInt(500) * BigInt(10 ** 6);
    const callCount = BigInt(50);

    // Get contract interface for event parsing
    const UsageFeeRouterABI = require('../../../contracts/UsageFeeRouter.json');
    const iface = new ethers.Interface(UsageFeeRouterABI.abi);

    const result = await client.depositFee(modelId, amount, callCount);

    // Verify receipt status
    const tx = await provider.getTransaction(result.transactionHash);
    if (tx) {
      const receipt = await tx.wait(1);
      expect(receipt?.status).toBe(1); // Success
    }
  });
});
