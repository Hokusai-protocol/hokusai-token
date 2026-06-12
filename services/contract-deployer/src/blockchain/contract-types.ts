import { ethers } from 'ethers';

export type DeltaVerifierContract = ethers.Contract & {
  processedIdempotencyKeys(idempotencyKey: string): Promise<boolean>;
  submitMintRequest(
    modelId: bigint,
    payload: Record<string, unknown>,
    contributors: Array<{ walletAddress: string; weight: number }>,
    attesterSignatures: string[],
    overrides?: { gasLimit: bigint; gasPrice: bigint },
  ): Promise<ethers.ContractTransactionResponse | null>;
};

export type ModelRegistryContract = ethers.Contract & {
  registerModel(
    modelId: string,
    tokenAddress: string,
    metricName: string,
    mlflowRunId: string,
  ): Promise<ethers.ContractTransactionResponse | null>;
  getTokenAddress(modelId: string): Promise<string>;
  getModelInfo(
    modelId: string,
  ): Promise<[string, string, string, bigint, boolean]>;
  owner(): Promise<string>;
};

export type HokusaiTokenContract = ethers.Contract & {
  mint(to: string, amount: bigint): Promise<ethers.ContractTransactionResponse | null>;
  burn(amount: bigint): Promise<ethers.ContractTransactionResponse | null>;
  balanceOf(account: string): Promise<bigint>;
  totalSupply(): Promise<bigint>;
  transfer(to: string, amount: bigint): Promise<boolean>;
};

export type BurnAuctionContract = ethers.Contract & {
  initiateAuction(
    modelId: bigint,
    initialPrice: bigint,
  ): Promise<ethers.ContractTransactionResponse | null>;
  placeBid(auctionId: bigint, bidAmount: bigint): Promise<ethers.ContractTransactionResponse | null>;
};

export function typedContract<T>(
  address: string,
  abi: string[] | ethers.Interface,
  runner: ethers.Provider | ethers.Signer | null,
): T {
  return new ethers.Contract(address, abi, runner) as T;
}
