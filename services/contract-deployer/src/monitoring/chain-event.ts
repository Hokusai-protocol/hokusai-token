import { ethers } from 'ethers';

export type ChainEventInput = ethers.EventLog | ethers.ContractEventPayload;
export type ConfirmedEvent = ethers.EventLog & { timestamp: number };

/** Unwrap v6 subscription payloads, wait for confirmations and reject orphaned logs. */
export async function confirmEvent(
  provider: ethers.Provider,
  input: ChainEventInput,
  confirmations = 2,
): Promise<ConfirmedEvent | null> {
  const log = 'log' in input ? input.log : input;
  if (log.removed) {
    return null;
  }
  if (!log.transactionHash || !log.blockHash || !Number.isInteger(log.index)) {
    throw new Error('Incomplete blockchain event metadata');
  }
  const receipt = await provider.waitForTransaction(log.transactionHash, confirmations, 120_000);
  if (!receipt || receipt.blockHash !== log.blockHash) {
    return null;
  }
  const block = await provider.getBlock(log.blockNumber);
  if (!block || block.hash !== log.blockHash) {
    return null;
  }
  // Preserve EventLog methods used by historical discovery.
  return Object.assign(log, { timestamp: block.timestamp });
}
