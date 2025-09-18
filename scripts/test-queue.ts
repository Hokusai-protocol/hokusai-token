import { createClient } from 'redis';
import * as dotenv from 'dotenv';

dotenv.config();

interface TestMessage {
  modelId: string;
  name: string;
  symbol: string;
  initialSupply: string;
  metadata: {
    description: string;
    accuracy: number;
    version: string;
    [key: string]: any;
  };
}

class QueueTester {
  private redis: any;
  private queueName: string = 'hokusai:model_ready_queue';

  async connect(): Promise<void> {
    const redisUrl = process.env.REDIS_URL || 'redis://master.hokusai-redis-development.lenvj6.use1.cache.amazonaws.com:6379/0';
    
    console.log('🔗 Connecting to Redis...');
    this.redis = createClient({ url: redisUrl });
    
    this.redis.on('error', (err: any) => console.error('Redis Client Error', err));
    
    await this.redis.connect();
    console.log('✅ Connected to Redis');
  }

  async sendTestMessage(message: TestMessage): Promise<void> {
    console.log(`\n📤 Sending message to queue: ${this.queueName}`);
    console.log('Message:', JSON.stringify(message, null, 2));
    
    const messageStr = JSON.stringify(message);
    await this.redis.lPush(this.queueName, messageStr);
    
    console.log('✅ Message sent successfully');
  }

  async checkQueueDepth(): Promise<void> {
    const depth = await this.redis.lLen(this.queueName);
    console.log(`\n📊 Queue depth for ${this.queueName}: ${depth} messages`);
  }

  async checkProcessingQueue(): Promise<void> {
    const processingQueue = 'hokusai:processing_queue';
    const depth = await this.redis.lLen(processingQueue);
    console.log(`📊 Processing queue depth: ${depth} messages`);
  }

  async checkOutboundQueue(): Promise<void> {
    const outboundQueue = 'hokusai:token_deployed_queue';
    const depth = await this.redis.lLen(outboundQueue);
    console.log(`📊 Outbound queue depth: ${depth} messages`);
    
    if (depth > 0) {
      console.log('\n📥 Recent deployed tokens:');
      const messages = await this.redis.lRange(outboundQueue, 0, 4);
      messages.forEach((msg: string, index: number) => {
        try {
          const parsed = JSON.parse(msg);
          console.log(`${index + 1}. Model: ${parsed.modelId}, Token: ${parsed.tokenAddress}`);
        } catch (e) {
          console.log(`${index + 1}. [Invalid JSON]`);
        }
      });
    }
  }

  async checkDeadLetterQueue(): Promise<void> {
    const dlq = 'hokusai:dlq';
    const depth = await this.redis.lLen(dlq);
    console.log(`⚠️  Dead letter queue depth: ${depth} messages`);
    
    if (depth > 0) {
      console.log('\n❌ Failed messages in DLQ:');
      const messages = await this.redis.lRange(dlq, 0, 4);
      messages.forEach((msg: string, index: number) => {
        try {
          const parsed = JSON.parse(msg);
          console.log(`${index + 1}. Error: ${parsed.error}, Model: ${parsed.originalMessage?.modelId}`);
        } catch (e) {
          console.log(`${index + 1}. ${msg.substring(0, 100)}...`);
        }
      });
    }
  }

  async monitorQueues(intervalSeconds: number = 5): Promise<void> {
    console.log(`\n👀 Monitoring queues every ${intervalSeconds} seconds... (Ctrl+C to stop)\n`);
    
    const monitor = async () => {
      console.log(`\n--- Queue Status at ${new Date().toISOString()} ---`);
      await this.checkQueueDepth();
      await this.checkProcessingQueue();
      await this.checkOutboundQueue();
      await this.checkDeadLetterQueue();
    };

    await monitor();
    setInterval(monitor, intervalSeconds * 1000);
  }

  async clearQueue(queueName: string): Promise<void> {
    console.log(`\n🗑️  Clearing queue: ${queueName}`);
    const result = await this.redis.del(queueName);
    console.log(`✅ Queue cleared (${result} keys deleted)`);
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
    console.log('👋 Disconnected from Redis');
  }
}

async function main() {
  const tester = new QueueTester();
  
  try {
    await tester.connect();

    const command = process.argv[2];
    
    switch (command) {
      case 'send':
        // Send a test message
        const testMessage: TestMessage = {
          modelId: `test-model-${Date.now()}`,
          name: 'Test Model ' + new Date().toISOString().split('T')[0],
          symbol: 'TM' + Math.floor(Math.random() * 1000),
          initialSupply: '1000000000000000000000', // 1000 tokens
          metadata: {
            description: 'Test model deployed via queue tester',
            accuracy: 0.95,
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            environment: 'sepolia-test'
          }
        };
        
        await tester.sendTestMessage(testMessage);
        await tester.checkQueueDepth();
        break;
        
      case 'send-batch':
        // Send multiple test messages
        const count = parseInt(process.argv[3] || '5');
        console.log(`\n📦 Sending ${count} test messages...`);
        
        for (let i = 0; i < count; i++) {
          const batchMessage: TestMessage = {
            modelId: `batch-model-${Date.now()}-${i}`,
            name: `Batch Model ${i + 1}`,
            symbol: `BM${i}`,
            initialSupply: '500000000000000000000', // 500 tokens
            metadata: {
              description: `Batch test model ${i + 1} of ${count}`,
              accuracy: 0.9 + Math.random() * 0.1,
              version: '1.0.0',
              batchId: Date.now(),
              index: i
            }
          };
          
          await tester.sendTestMessage(batchMessage);
          await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between messages
        }
        
        await tester.checkQueueDepth();
        break;
        
      case 'status':
        // Check all queue statuses
        await tester.checkQueueDepth();
        await tester.checkProcessingQueue();
        await tester.checkOutboundQueue();
        await tester.checkDeadLetterQueue();
        break;
        
      case 'monitor':
        // Monitor queues continuously
        const interval = parseInt(process.argv[3] || '5');
        await tester.monitorQueues(interval);
        break;
        
      case 'clear':
        // Clear a specific queue
        const queueToClear = process.argv[3];
        if (!queueToClear) {
          console.error('❌ Please specify queue name to clear');
          console.log('Available queues:');
          console.log('  - hokusai:model_ready_queue');
          console.log('  - hokusai:processing_queue');
          console.log('  - hokusai:token_deployed_queue');
          console.log('  - hokusai:dlq');
        } else {
          await tester.clearQueue(queueToClear);
        }
        break;
        
      case 'clear-all':
        // Clear all queues
        console.log('⚠️  Clearing all queues...');
        await tester.clearQueue('hokusai:model_ready_queue');
        await tester.clearQueue('hokusai:processing_queue');
        await tester.clearQueue('hokusai:token_deployed_queue');
        await tester.clearQueue('hokusai:dlq');
        console.log('✅ All queues cleared');
        break;
        
      default:
        console.log('📖 Usage:');
        console.log('  npm run test-queue send           - Send a single test message');
        console.log('  npm run test-queue send-batch [n] - Send n test messages (default: 5)');
        console.log('  npm run test-queue status         - Check all queue statuses');
        console.log('  npm run test-queue monitor [sec]  - Monitor queues every n seconds (default: 5)');
        console.log('  npm run test-queue clear [queue]  - Clear specific queue');
        console.log('  npm run test-queue clear-all      - Clear all queues');
    }
    
    if (command !== 'monitor') {
      await tester.disconnect();
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
    await tester.disconnect();
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  process.exit(0);
});

main();