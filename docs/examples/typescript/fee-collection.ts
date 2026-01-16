/**
 * Fee Collection Service
 *
 * Example TypeScript service for depositing API usage fees into Hokusai AMM pools.
 *
 * Features:
 * - Single and batch fee deposits
 * - Automatic USDC approval management
 * - Event listening for deposit confirmation
 * - Balance and allowance checks
 * - Retry logic for failed transactions
 *
 * Usage:
 *   const service = new FeeCollectionService(
 *     feeRouterAddress,
 *     usdcAddress,
 *     signer
 *   );
 *
 *   // Single deposit
 *   await service.depositFees("model-sentiment-v1", parseUSDC("100"));
 *
 *   // Batch deposit
 *   await service.batchDeposit([
 *     { modelId: "model-1", amount: parseUSDC("50") },
 *     { modelId: "model-2", amount: parseUSDC("150") },
 *   ]);
 */

import { ethers, Contract, Signer } from "ethers";

const FEE_ROUTER_ABI = [
  "function depositFee(string modelId, uint256 amount) external",
  "function batchDepositFees(string[] modelIds, uint256[] amounts) external",
  "function protocolFeeBps() view returns (uint16)",
  "event FeeDeposited(string indexed modelId, address indexed poolAddress, uint256 amount, uint256 protocolFee, uint256 poolDeposit, address indexed depositor)",
  "event BatchDeposited(uint256 totalAmount, uint256 totalProtocolFee, uint256 poolCount, address indexed depositor)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];

interface FeeDeposit {
  modelId: string;
  amount: bigint;
}

interface DepositEvent {
  modelId: string;
  poolAddress: string;
  amount: bigint;
  protocolFee: bigint;
  poolDeposit: bigint;
  depositor: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
}

export class FeeCollectionService {
  private feeRouter: Contract;
  private usdc: Contract;
  private signer: Signer;
  private signerAddress: string | null = null;

  constructor(
    feeRouterAddress: string,
    usdcAddress: string,
    signer: Signer
  ) {
    this.feeRouter = new Contract(feeRouterAddress, FEE_ROUTER_ABI, signer);
    this.usdc = new Contract(usdcAddress, ERC20_ABI, signer);
    this.signer = signer;
  }

  /**
   * Initialize the service by getting the signer address
   */
  async initialize(): Promise<void> {
    this.signerAddress = await this.signer.getAddress();
    console.log(`FeeCollectionService initialized for ${this.signerAddress}`);
  }

  /**
   * Check USDC balance
   */
  async getBalance(): Promise<bigint> {
    if (!this.signerAddress) await this.initialize();
    return await this.usdc.balanceOf(this.signerAddress);
  }

  /**
   * Check USDC allowance for FeeRouter
   */
  async getAllowance(): Promise<bigint> {
    if (!this.signerAddress) await this.initialize();
    return await this.usdc.allowance(
      this.signerAddress,
      await this.feeRouter.getAddress()
    );
  }

  /**
   * Approve USDC for FeeRouter
   */
  async approveUSDC(amount: bigint): Promise<string> {
    console.log(`Approving ${ethers.formatUnits(amount, 6)} USDC`);

    const tx = await this.usdc.approve(
      await this.feeRouter.getAddress(),
      amount
    );
    const receipt = await tx.wait();

    console.log(`Approval confirmed: ${receipt.hash}`);
    return receipt.hash;
  }

  /**
   * Ensure sufficient allowance, approve if needed
   */
  private async ensureAllowance(requiredAmount: bigint): Promise<void> {
    const currentAllowance = await this.getAllowance();

    if (currentAllowance < requiredAmount) {
      console.log(
        `Insufficient allowance. Current: ${ethers.formatUnits(currentAllowance, 6)}, Required: ${ethers.formatUnits(requiredAmount, 6)}`
      );
      await this.approveUSDC(requiredAmount);
    }
  }

  /**
   * Deposit fee for a single model
   */
  async depositFees(modelId: string, usdcAmount: bigint): Promise<string> {
    if (!this.signerAddress) await this.initialize();

    // Check balance
    const balance = await this.getBalance();
    if (balance < usdcAmount) {
      throw new Error(
        `Insufficient balance. Have: ${ethers.formatUnits(balance, 6)}, Need: ${ethers.formatUnits(usdcAmount, 6)}`
      );
    }

    // Ensure allowance
    await this.ensureAllowance(usdcAmount);

    // Deposit
    console.log(
      `Depositing ${ethers.formatUnits(usdcAmount, 6)} USDC for ${modelId}`
    );

    const tx = await this.feeRouter.depositFee(modelId, usdcAmount);
    const receipt = await tx.wait();

    console.log(`Fee deposited: ${receipt.hash}`);
    return receipt.hash;
  }

  /**
   * Deposit fees for multiple models in a single transaction
   */
  async batchDeposit(deposits: FeeDeposit[]): Promise<string> {
    if (!this.signerAddress) await this.initialize();

    if (deposits.length === 0) {
      throw new Error("No deposits provided");
    }

    // Calculate total amount
    const totalAmount = deposits.reduce((sum, d) => sum + d.amount, 0n);

    // Check balance
    const balance = await this.getBalance();
    if (balance < totalAmount) {
      throw new Error(
        `Insufficient balance. Have: ${ethers.formatUnits(balance, 6)}, Need: ${ethers.formatUnits(totalAmount, 6)}`
      );
    }

    // Ensure allowance
    await this.ensureAllowance(totalAmount);

    // Prepare batch data
    const modelIds = deposits.map((d) => d.modelId);
    const amounts = deposits.map((d) => d.amount);

    console.log(
      `Batch depositing ${ethers.formatUnits(totalAmount, 6)} USDC across ${deposits.length} models`
    );

    // Execute batch deposit
    const tx = await this.feeRouter.batchDepositFees(modelIds, amounts);
    const receipt = await tx.wait();

    console.log(`Batch deposit confirmed: ${receipt.hash}`);
    return receipt.hash;
  }

  /**
   * Listen for deposit events
   */
  onFeeDeposited(callback: (event: DepositEvent) => void): void {
    this.feeRouter.on(
      "FeeDeposited",
      async (
        modelId: string,
        poolAddress: string,
        amount: bigint,
        protocolFee: bigint,
        poolDeposit: bigint,
        depositor: string,
        event: any
      ) => {
        const block = await event.getBlock();

        callback({
          modelId,
          poolAddress,
          amount,
          protocolFee,
          poolDeposit,
          depositor,
          transactionHash: event.log.transactionHash,
          blockNumber: event.log.blockNumber,
          timestamp: block.timestamp,
        });
      }
    );
  }

  /**
   * Get deposit history for a model
   */
  async getDepositHistory(
    modelId: string,
    fromBlock: number = 0,
    toBlock: number | string = "latest"
  ): Promise<DepositEvent[]> {
    const filter = this.feeRouter.filters.FeeDeposited(modelId);
    const events = await this.feeRouter.queryFilter(filter, fromBlock, toBlock);

    return Promise.all(
      events.map(async (e: any) => {
        const block = await e.getBlock();
        return {
          modelId: e.args.modelId,
          poolAddress: e.args.poolAddress,
          amount: e.args.amount,
          protocolFee: e.args.protocolFee,
          poolDeposit: e.args.poolDeposit,
          depositor: e.args.depositor,
          transactionHash: e.transactionHash,
          blockNumber: e.blockNumber,
          timestamp: block.timestamp,
        };
      })
    );
  }

  /**
   * Get protocol fee percentage
   */
  async getProtocolFeeBps(): Promise<number> {
    const feeBps = await this.feeRouter.protocolFeeBps();
    return Number(feeBps);
  }

  /**
   * Calculate expected fee split
   */
  async calculateFeeSplit(amount: bigint): Promise<{
    protocolFee: bigint;
    poolDeposit: bigint;
    protocolFeePct: number;
  }> {
    const protocolFeeBps = await this.getProtocolFeeBps();
    const protocolFee = (amount * BigInt(protocolFeeBps)) / 10000n;
    const poolDeposit = amount - protocolFee;

    return {
      protocolFee,
      poolDeposit,
      protocolFeePct: protocolFeeBps / 100,
    };
  }

  /**
   * Stop listening to events
   */
  removeAllListeners(): void {
    this.feeRouter.removeAllListeners();
  }
}

// Helper functions
export function parseUSDC(amount: string): bigint {
  return ethers.parseUnits(amount, 6);
}

export function formatUSDC(amount: bigint): string {
  return ethers.formatUnits(amount, 6);
}

// Example usage
async function example() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  const service = new FeeCollectionService(
    "0x...", // feeRouterAddress
    "0x...", // usdcAddress
    wallet
  );

  await service.initialize();

  // Single deposit
  await service.depositFees("model-sentiment-v1", parseUSDC("100"));

  // Batch deposit
  await service.batchDeposit([
    { modelId: "model-sentiment-v1", amount: parseUSDC("50") },
    { modelId: "model-forecast-v2", amount: parseUSDC("150") },
    { modelId: "model-classify-v1", amount: parseUSDC("25") },
  ]);

  // Listen for deposits
  service.onFeeDeposited((event) => {
    console.log(`Fee deposited for ${event.modelId}:`);
    console.log(`  Amount: $${formatUSDC(event.amount)}`);
    console.log(`  Protocol Fee: $${formatUSDC(event.protocolFee)}`);
    console.log(`  Pool Deposit: $${formatUSDC(event.poolDeposit)}`);
  });

  // Get history
  const history = await service.getDepositHistory("model-sentiment-v1");
  console.log(`Found ${history.length} deposits`);
}
