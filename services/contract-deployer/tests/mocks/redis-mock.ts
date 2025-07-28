import { RedisClientType } from 'redis';

export function createMockRedisClient(): jest.Mocked<RedisClientType> {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    
    // List operations
    lPush: jest.fn(),
    rPush: jest.fn(),
    lPop: jest.fn(),
    rPop: jest.fn(),
    brPopLPush: jest.fn(),
    lRem: jest.fn(),
    lLen: jest.fn(),
    lRange: jest.fn(),
    
    // String operations
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    
    // Transaction operations
    multi: jest.fn(),
    exec: jest.fn(),
    
    // Pub/Sub operations
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    publish: jest.fn(),
    
    // Hash operations
    hSet: jest.fn(),
    hGet: jest.fn(),
    hGetAll: jest.fn(),
    hDel: jest.fn(),
    
    // Set operations
    sAdd: jest.fn(),
    sRem: jest.fn(),
    sMembers: jest.fn(),
    sIsMember: jest.fn(),
    
    // Sorted set operations
    zAdd: jest.fn(),
    zRem: jest.fn(),
    zRange: jest.fn(),
    zScore: jest.fn(),
    
    // Key operations
    keys: jest.fn(),
    scan: jest.fn(),
    ttl: jest.fn(),
    expire: jest.fn(),
    
    // Events
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    
    // Connection state
    isOpen: true,
    isReady: true,
  } as any;
}

export function createMockRedisMulti() {
  return {
    lPush: jest.fn().mockReturnThis(),
    rPush: jest.fn().mockReturnThis(),
    hSet: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([])
  };
}