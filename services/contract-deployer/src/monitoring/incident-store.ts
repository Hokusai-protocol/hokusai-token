/** Public monitoring state only; keys are scoped by chain and deployment. */
export interface MonitoringRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number; NX?: true }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class IncidentStore {
  private memory = new Map<string, { value: string; expires: number }>();
  constructor(
    private scope: string,
    private redis?: MonitoringRedis,
  ) {}

  private key(key: string): string {
    return `hokusai:monitor:v2:${this.scope}:${key.toLowerCase()}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const scoped = this.key(key);
    if (this.redis) {
      const value = await this.redis.get(scoped);
      return value === null ? null : (JSON.parse(value) as T);
    }
    const entry = this.memory.get(scoped);
    return entry && entry.expires > Date.now() ? (JSON.parse(entry.value) as T) : null;
  }

  async put(key: string, value: unknown, ttlMs = 30 * 86400_000): Promise<void> {
    const scoped = this.key(key);
    const serialized = JSON.stringify(value);
    if (this.redis) {
      await this.redis.set(scoped, serialized, { PX: ttlMs });
    } else {
      this.memory.set(scoped, { value: serialized, expires: Date.now() + ttlMs });
    }
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    if (this.redis) {
      return (await this.redis.set(this.key(key), 'true', { NX: true, PX: ttlMs })) === 'OK';
    }
    if (await this.get(key)) {
      return false;
    }
    await this.put(key, true, ttlMs);
    return true;
  }

  async remove(key: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(this.key(key));
    } else {
      this.memory.delete(this.key(key));
    }
  }
}
