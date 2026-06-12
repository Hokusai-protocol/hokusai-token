import { ethers } from 'ethers';

export type HokusaiTokenContract = ethers.Contract & {
  totalSupply(): Promise<bigint>;
  balanceOf(account: string): Promise<bigint>;
};

export type ModelRegistryContract = ethers.Contract & {
  registerModel(
    modelId: string,
    tokenAddress: string,
    metricName: string,
    mlflowRunId: string,
  ): Promise<ethers.ContractTransactionResponse>;
  getTokenAddress(modelId: string): Promise<string>;
  getModelInfo(modelId: string): Promise<{
    tokenAddress: string;
    metricName: string;
    mlflowRunId: string;
    registrationTime: bigint;
    isActive: boolean;
  }>;
  owner(): Promise<string>;
};

export type TokenManagerContract = ethers.Contract & {
  owner(): Promise<string>;
};

export type DeltaVerifierContract = ethers.Contract & {
  SUBMITTER_ROLE(): Promise<string>;
  hasRole(role: string, account: string): Promise<boolean>;
};

export type AmmFactoryContract = ethers.Contract & {
  getPoolByModelId(modelId: string): Promise<string>;
  getAllPools(): Promise<string[]>;
};

export type UsageFeeRouterContract = ethers.Contract & {
  owner(): Promise<string>;
};

export type HokusaiAmmContract = ethers.Contract & {
  reserveBalance(): Promise<bigint>;
  spotPrice(): Promise<bigint>;
  hokusaiToken(): Promise<string>;
  paused(): Promise<boolean>;
};
