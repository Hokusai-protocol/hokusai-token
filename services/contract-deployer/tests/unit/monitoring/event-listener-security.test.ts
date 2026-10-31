import { ethers } from 'ethers';
import { EventListener, loadMaintenance } from '../../../src/monitoring/event-listener';
import { DEFAULT_THRESHOLDS, PoolConfig } from '../../../src/config/monitoring-config';
import { IncidentStore } from '../../../src/monitoring/incident-store';

const pool = { modelId: '27', ammAddress: '0x' + '11'.repeat(20) } as PoolConfig;
const actor = '0x' + '22'.repeat(20);
const event = {
  transactionHash: '0xtx',
  blockHash: '0xblock',
  blockNumber: 123,
  index: 4,
  timestamp: 1234,
};

describe('pause severity and maintenance', () => {
  afterEach(() => {
    delete process.env.MONITORING_MAINTENANCE_JSON;
  });
  async function handle(paused: boolean, sender = actor) {
    const alerts = jest.fn().mockResolvedValue(undefined);
    const store = new IncidentStore('test');
    const listener = new EventListener(
      {} as ethers.Provider,
      DEFAULT_THRESHOLDS,
      { onAlert: alerts },
      store,
    );
    await (listener as any).handlePausedEvent(pool, sender, event, paused);
    return { alert: alerts.mock.calls[0][0], store };
  }
  it('keeps unexpected pauses critical and records mined metadata', async () => {
    const { alert } = await handle(true);
    expect(alert.priority).toBe('critical');
    expect(alert.event).toMatchObject({ transactionHash: '0xtx', logIndex: 4, timestamp: 1234 });
  });
  it('marks unpause as informational', async () => {
    expect((await handle(false)).alert.priority).toBe('info');
  });
  it('limits maintenance to the exact pool, expected actor and expiry', async () => {
    process.env.MONITORING_MAINTENANCE_JSON = JSON.stringify([
      {
        pool: pool.ammAddress,
        actors: [actor],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ]);
    const planned = await handle(true);
    expect(planned.alert.priority).toBe('info');
    expect(await planned.store.get(`maintenance:${pool.ammAddress}`)).toBeGreaterThan(Date.now());
    const unexpected = await handle(true, '0x' + '33'.repeat(20));
    expect(unexpected.alert.priority).toBe('critical');
    expect(await unexpected.store.get(`maintenance:${pool.ammAddress}`)).toBeNull();
  });
  it('rejects unlimited or malformed maintenance configuration', () => {
    process.env.MONITORING_MAINTENANCE_JSON = JSON.stringify([
      { pool: pool.ammAddress, actors: [actor], expiresAt: '2099-01-01' },
    ]);
    expect(loadMaintenance).toThrow('expiry within 24 hours');
  });
  it('subscribes to the October parameter-change signature as well as the legacy signature', () => {
    const iface = new ethers.Interface((EventListener as any).POOL_ABI);
    expect(iface.getEvent('ParametersUpdated(uint256,uint256)')).not.toBeNull();
    expect(iface.getEvent('ParametersUpdated(uint256,uint256,uint16)')).not.toBeNull();
  });
});
