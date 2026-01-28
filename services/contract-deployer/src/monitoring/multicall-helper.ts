import { ethers } from 'ethers';
import { logger } from '../utils/logger';

/**
 * Multicall3 Helper
 *
 * Batches multiple contract calls into a single RPC request
 * This significantly reduces RPC usage when fetching state from multiple pools
 *
 * Multicall3 is deployed on most networks at: 0xcA11bde05977b3631167028862bE2a173976CA11
 */

// Multicall3 contract address (same on all major networks)
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'
];

export interface Call {
  target: string;      // Contract address
  allowFailure: boolean; // Whether to continue if this call fails
  callData: string;    // Encoded function call
}

export interface Result {
  success: boolean;
  returnData: string;
}

export class MulticallHelper {
  private provider: ethers.Provider;
  private multicall: ethers.Contract;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  }

  /**
   * Execute multiple calls in a single RPC request
   */
  async aggregate(calls: Call[]): Promise<Result[]> {
    if (calls.length === 0) {
      return [];
    }

    try {
      const results = await this.multicall.aggregate3(calls);
      return results.map((r: any) => ({
        success: r.success,
        returnData: r.returnData
      }));
    } catch (error) {
      logger.error('Multicall aggregate failed:', error);
      throw error;
    }
  }

  /**
   * Batch read pool state for multiple pools
   * Returns array of [reserveBalance, spotPrice, paused, tokenSupply] for each pool
   */
  async batchReadPoolStates(
    poolAddresses: string[],
    tokenAddresses: string[]
  ): Promise<Array<{
    reserveBalance: bigint;
    spotPrice: bigint;
    paused: boolean;
    tokenSupply: bigint;
  } | null>> {
    if (poolAddresses.length !== tokenAddresses.length) {
      throw new Error('Pool and token address arrays must have same length');
    }

    const poolInterface = new ethers.Interface([
      'function reserveBalance() view returns (uint256)',
      'function spotPrice() view returns (uint256)',
      'function paused() view returns (bool)'
    ]);

    const tokenInterface = new ethers.Interface([
      'function totalSupply() view returns (uint256)'
    ]);

    // Build calls array
    const calls: Call[] = [];

    for (let i = 0; i < poolAddresses.length; i++) {
      const poolAddr = poolAddresses[i];
      const tokenAddr = tokenAddresses[i];

      // 3 calls per pool + 1 token call = 4 calls per pool
      calls.push({
        target: poolAddr,
        allowFailure: true,
        callData: poolInterface.encodeFunctionData('reserveBalance')
      });
      calls.push({
        target: poolAddr,
        allowFailure: true,
        callData: poolInterface.encodeFunctionData('spotPrice')
      });
      calls.push({
        target: poolAddr,
        allowFailure: true,
        callData: poolInterface.encodeFunctionData('paused')
      });
      calls.push({
        target: tokenAddr,
        allowFailure: true,
        callData: tokenInterface.encodeFunctionData('totalSupply')
      });
    }

    // Execute multicall
    const results = await this.aggregate(calls);

    // Parse results (4 results per pool)
    const poolStates = [];
    for (let i = 0; i < poolAddresses.length; i++) {
      const baseIdx = i * 4;
      const reserveResult = results[baseIdx];
      const priceResult = results[baseIdx + 1];
      const pausedResult = results[baseIdx + 2];
      const supplyResult = results[baseIdx + 3];

      // If any call failed, return null for this pool
      if (!reserveResult.success || !priceResult.success ||
          !pausedResult.success || !supplyResult.success) {
        logger.warn(`Failed to read state for pool ${poolAddresses[i]}`);
        poolStates.push(null);
        continue;
      }

      try {
        poolStates.push({
          reserveBalance: poolInterface.decodeFunctionResult('reserveBalance', reserveResult.returnData)[0],
          spotPrice: poolInterface.decodeFunctionResult('spotPrice', priceResult.returnData)[0],
          paused: poolInterface.decodeFunctionResult('paused', pausedResult.returnData)[0],
          tokenSupply: tokenInterface.decodeFunctionResult('totalSupply', supplyResult.returnData)[0]
        });
      } catch (error) {
        logger.error(`Failed to decode results for pool ${poolAddresses[i]}:`, error);
        poolStates.push(null);
      }
    }

    return poolStates;
  }

  /**
   * Check if Multicall3 is available on this network
   */
  async isAvailable(): Promise<boolean> {
    try {
      const code = await this.provider.getCode(MULTICALL3_ADDRESS);
      return code !== '0x';
    } catch (error) {
      logger.error('Failed to check Multicall3 availability:', error);
      return false;
    }
  }
}
