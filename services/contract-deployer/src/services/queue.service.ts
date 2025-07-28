import { createClient, RedisClientType } from 'redis';
import { Logger } from 'winston';
import { QueueMessage } from '../types';

export class QueueService {
  private client: RedisClientType;
  private connected = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly logger: Logger,
  ) {
    this.client = createClient({
      socket: {
        host: this.host,
        port: this.port,
      },
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis client error:', err);
    });

    this.client.on('connect', () => {
      this.logger.info('Connected to Redis');
      this.connected = true;
    });

    this.client.on('disconnect', () => {
      this.logger.warn('Disconnected from Redis');
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
    }
  }

  async enqueue(queueName: string, message: QueueMessage): Promise<void> {
    await this.client.rPush(queueName, JSON.stringify(message));
  }

  async dequeue(queueName: string, timeout = 0): Promise<QueueMessage | null> {
    const result = await this.client.blPop({ key: queueName, timeout });
    if (result) {
      return JSON.parse(result.element) as QueueMessage;
    }
    return null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}