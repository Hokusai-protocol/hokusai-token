import { ethers } from 'ethers';
import { confirmEvent } from '../../../src/monitoring/chain-event';

describe('ethers v6 event payloads and canonicality', () => {
  function fixture() {
    const iface = new ethers.Interface(['event Paused(address account)']);
    const fragment = iface.getEvent('Paused')!;
    const provider = {
      waitForTransaction: jest.fn().mockResolvedValue({ blockHash: '0x' + 'ab'.repeat(32) }),
      getBlock: jest.fn().mockResolvedValue({ hash: '0x' + 'ab'.repeat(32), timestamp: 1234 }),
    };
    const encoded = iface.encodeEventLog(fragment, ['0x' + '11'.repeat(20)]);
    const log = new ethers.Log(
      {
        ...encoded,
        address: '0x' + '22'.repeat(20),
        blockHash: '0x' + 'ab'.repeat(32),
        blockNumber: 100,
        transactionHash: '0x' + 'cd'.repeat(32),
        transactionIndex: 0,
        index: 7,
        removed: false,
      },
      provider as unknown as ethers.Provider,
    );
    const contract = new ethers.Contract(log.address, iface);
    const payload = new ethers.ContractEventPayload(contract, null, 'Paused', fragment, log);
    return { provider, payload };
  }

  it('unwraps an actual ContractEventPayload and uses mined block time', async () => {
    const { provider, payload } = fixture();
    expect((payload as any).transactionHash).toBeUndefined();
    const event = await confirmEvent(provider as unknown as ethers.Provider, payload);
    expect(event).toMatchObject({
      transactionHash: payload.log.transactionHash,
      blockNumber: 100,
      index: 7,
      timestamp: 1234,
    });
    expect(provider.waitForTransaction).toHaveBeenCalledWith(
      payload.log.transactionHash,
      2,
      120_000,
    );
  });

  it('rejects a transaction moved to a different block by a reorg', async () => {
    const { provider, payload } = fixture();
    provider.waitForTransaction.mockResolvedValue({ blockHash: 'orphan' });
    expect(await confirmEvent(provider as unknown as ethers.Provider, payload)).toBeNull();
  });

  it('rejects a noncanonical block even when the receipt matches', async () => {
    const { provider, payload } = fixture();
    provider.getBlock.mockResolvedValue({ hash: 'different', timestamp: 1234 });
    expect(await confirmEvent(provider as unknown as ethers.Provider, payload)).toBeNull();
  });
});
