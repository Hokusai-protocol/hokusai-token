import { ethers } from 'ethers';
import { PoolDiscovery, PoolDiscoveryOrigin } from '../../../src/monitoring/pool-discovery';
import { PoolConfig } from '../../../src/config/monitoring-config';

const pool: PoolConfig = {
  modelId: 'model-1',
  tokenAddress: '0x0000000000000000000000000000000000000001',
  ammAddress: '0x0000000000000000000000000000000000000002',
  crr: 200_000,
  tradeFee: 30,
  protocolFee: 10,
  ibrDuration: 0,
  flatCurveThreshold: '0',
  flatCurvePrice: '0',
};

describe('PoolDiscovery origins', () => {
  it('marks configured startup inventory as bootstrap discovery', async () => {
    const discovery = new PoolDiscovery(
      {} as ethers.Provider,
      '0x0000000000000000000000000000000000000003',
    );
    const callback = jest.fn<Promise<void>, [PoolConfig, PoolDiscoveryOrigin]>(() =>
      Promise.resolve(),
    );
    discovery.onPoolDiscovered(callback);

    await discovery.addInitialPools([pool]);

    expect(callback).toHaveBeenCalledWith(pool, 'bootstrap');
  });
});
