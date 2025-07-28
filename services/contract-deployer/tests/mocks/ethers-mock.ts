import { ethers } from 'ethers';

export function createMockProvider(): jest.Mocked<ethers.Provider> {
  return {
    getNetwork: jest.fn(),
    getBlockNumber: jest.fn(),
    getBlock: jest.fn(),
    getTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
    getBalance: jest.fn(),
    getCode: jest.fn(),
    getStorage: jest.fn(),
    getLogs: jest.fn(),
    
    // Gas estimation
    estimateGas: jest.fn(),
    getFeeData: jest.fn(),
    getGasPrice: jest.fn(),
    
    // ENS
    resolveName: jest.fn(),
    lookupAddress: jest.fn(),
    
    // Events
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    removeAllListeners: jest.fn(),
    
    // Calls
    call: jest.fn(),
    broadcastTransaction: jest.fn(),
    
    // Block methods
    waitForBlock: jest.fn(),
    waitForTransaction: jest.fn(),
    
    // Network detection
    detectNetwork: jest.fn(),
    
    // Provider info
    connection: {
      url: 'http://localhost:8545'
    },
    
    destroy: jest.fn(),
    
    // Required properties
    _isProvider: true,
  } as any;
}

export function createMockSigner(): jest.Mocked<ethers.Signer> {
  return {
    provider: createMockProvider(),
    getAddress: jest.fn(),
    signMessage: jest.fn(),
    signTransaction: jest.fn(),
    signTypedData: jest.fn(),
    connect: jest.fn(),
    
    // Transaction methods
    sendTransaction: jest.fn(),
    getBalance: jest.fn(),
    getTransactionCount: jest.fn(),
    estimateGas: jest.fn(),
    call: jest.fn(),
    resolveName: jest.fn(),
    
    // Chain ID
    getChainId: jest.fn(),
    
    // Nonce management
    getNonce: jest.fn(),
    
    // Required properties
    _isSigner: true,
  } as any;
}

export function createMockContract(): jest.Mocked<ethers.Contract> {
  return {
    // Contract properties
    address: '0x1234567890123456789012345678901234567890',
    interface: {} as any,
    provider: createMockProvider(),
    signer: createMockSigner(),
    
    // Deployment
    deploymentTransaction: jest.fn(),
    waitForDeployment: jest.fn(),
    getAddress: jest.fn(),
    
    // Contract methods (can be customized per test)
    registerModel: jest.fn(),
    getTokenAddress: jest.fn(),
    getModelInfo: jest.fn(),
    owner: jest.fn(),
    setContributor: jest.fn(),
    
    // Event handling
    on: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    removeAllListeners: jest.fn(),
    filters: {
      ModelRegistered: jest.fn(),
      Transfer: jest.fn(),
      Approval: jest.fn(),
    },
    queryFilter: jest.fn(),
    
    // Transaction methods
    connect: jest.fn().mockReturnThis(),
    attach: jest.fn().mockReturnThis(),
    deployed: jest.fn().mockReturnThis(),
    
    // Estimation
    estimateGas: {},
    callStatic: {},
    functions: {},
    populateTransaction: {},
    
    // Fallback
    fallback: jest.fn(),
  } as any;
}

export function createMockContractFactory(): jest.Mocked<ethers.ContractFactory> {
  return {
    deploy: jest.fn(),
    attach: jest.fn(),
    connect: jest.fn().mockReturnThis(),
    
    // Factory properties
    interface: {} as any,
    bytecode: '0x',
    signer: createMockSigner(),
    
    // Deployment helpers
    getDeployTransaction: jest.fn(),
  } as any;
}

export function createMockTransactionResponse(): any {
  const tx = {
    hash: '0xabcdef1234567890123456789012345678901234567890123456789012345678',
    to: '0x1234567890123456789012345678901234567890',
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
    nonce: 1,
    gasLimit: ethers.toBigInt('3000000'),
    gasPrice: ethers.toBigInt('30000000000'),
    value: ethers.toBigInt('0'),
    data: '0x',
    chainId: 137n,
    
    // Methods
    wait: jest.fn(),
    confirmations: jest.fn(),
    
    // Required properties
    type: 2,
    accessList: null,
    maxPriorityFeePerGas: null,
    maxFeePerGas: null,
  };
  
  // Add private fields as symbols to satisfy TypeScript
  Object.defineProperty(tx, Symbol.for('private'), { value: {} });
  
  return tx;
}

export function createMockTransactionReceipt(): jest.Mocked<ethers.TransactionReceipt> {
  return {
    to: '0x1234567890123456789012345678901234567890',
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
    contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    hash: '0xabcdef1234567890123456789012345678901234567890123456789012345678',
    blockHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    blockNumber: 12345678,
    logs: [],
    gasUsed: ethers.toBigInt('2845632'),
    gasPrice: ethers.toBigInt('35000000000'),
    status: 1,
    confirmations: jest.fn(),
    
    // Required properties
    index: 0,
    type: 2,
    logsBloom: '0x',
    cumulativeGasUsed: ethers.toBigInt('5000000'),
    effectiveGasPrice: ethers.toBigInt('35000000000'),
  } as any;
}