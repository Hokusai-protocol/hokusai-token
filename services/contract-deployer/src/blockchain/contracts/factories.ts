import { ethers } from 'ethers';
import {
  AmmFactoryContract,
  DeltaVerifierContract,
  HokusaiAmmContract,
  HokusaiTokenContract,
  ModelRegistryContract,
  TokenManagerContract,
  UsageFeeRouterContract,
} from './interfaces';

export function getModelRegistryContract(
  address: string,
  runner: ethers.ContractRunner,
  abi: readonly string[],
): ModelRegistryContract {
  return new ethers.Contract(address, abi, runner) as unknown as ModelRegistryContract;
}

export function getTokenManagerContract(
  address: string,
  runner: ethers.ContractRunner,
  abi: readonly string[],
): TokenManagerContract {
  return new ethers.Contract(address, abi, runner) as unknown as TokenManagerContract;
}

export function getDeltaVerifierContract(
  address: string,
  runner: ethers.ContractRunner,
  abi: readonly string[],
): DeltaVerifierContract {
  return new ethers.Contract(address, abi, runner) as unknown as DeltaVerifierContract;
}

export function getAmmFactoryContract(
  address: string,
  runner: ethers.ContractRunner,
  abi: readonly string[],
): AmmFactoryContract {
  return new ethers.Contract(address, abi, runner) as unknown as AmmFactoryContract;
}

export function getUsageFeeRouterContract(
  address: string,
  runner: ethers.ContractRunner,
  abi: readonly string[],
): UsageFeeRouterContract {
  return new ethers.Contract(address, abi, runner) as unknown as UsageFeeRouterContract;
}

export function getHokusaiAmmContract(
  address: string,
  runner: ethers.ContractRunner,
  abi: readonly string[],
): HokusaiAmmContract {
  return new ethers.Contract(address, abi, runner) as unknown as HokusaiAmmContract;
}

export function getHokusaiTokenContract(
  address: string,
  runner: ethers.ContractRunner,
  abi: readonly string[],
): HokusaiTokenContract {
  return new ethers.Contract(address, abi, runner) as unknown as HokusaiTokenContract;
}
