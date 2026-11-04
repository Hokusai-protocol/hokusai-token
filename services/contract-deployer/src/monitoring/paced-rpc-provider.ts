import { ethers } from 'ethers';
import { setTimeout as delay } from 'timers/promises';

/** Bound backup traffic, including initialization bursts, rather than only periodic polling. */
export class PacedRpcProvider extends ethers.JsonRpcProvider {
  readonly usesConfirmedPolling = true;
  private pending: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    url: string,
    private intervalMs = 400,
  ) {
    // Backup URLs identify one fixed chain. Detect it once and retain the existing chain-ID gate.
    super(url, undefined, { batchMaxCount: 1, polling: true, staticNetwork: true });
  }

  override _send(
    payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[],
  ): Promise<ethers.JsonRpcResult[]> {
    const work = this.pending.then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (this.destroyed) {
          throw new Error('Backup provider destroyed');
        }
        await delay(Math.max(0, this.nextRequestAt - Date.now()));
        if (this.destroyed) {
          throw new Error('Backup provider destroyed');
        }
        this.nextRequestAt = Date.now() + this.intervalMs;
        const results = await super._send(payload);
        const throttled = results.some((result) => {
          const error = (result as unknown as { error?: { code: number; message: string } }).error;
          return error?.code === -32005 && /too many requests/i.test(error.message);
        });
        if (!throttled || attempt >= 2) {
          return results;
        }
        await delay(1000 * 2 ** attempt);
      }
    });
    this.pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
}
