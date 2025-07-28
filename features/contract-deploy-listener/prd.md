# Contract Deploy Listener - Product Requirements Document

## Executive Summary

The Contract Deploy Listener is a critical backend service that bridges the Hokusai ML Platform and the Hokusai smart contract ecosystem. This service monitors a Redis message queue for `model_ready_to_deploy` events, validates model deployment criteria, deploys corresponding ERC20 token contracts to the blockchain, and emits `token_deployed` events for downstream systems. The service ensures that only validated ML models meeting performance thresholds receive tokenization, maintaining the integrity of the Hokusai token economy.

## Problem Statement

Currently, there is a gap between the ML model validation pipeline and the smart contract deployment process. When ML models pass validation and meet performance thresholds, there is no automated mechanism to:
- Deploy corresponding token contracts
- Link deployed contracts to ML model metadata
- Ensure traceability between MLflow runs and blockchain addresses
- Notify downstream systems of successful deployments
- Handle deployment failures and retries gracefully

This manual process introduces delays, potential errors, and lacks the auditability required for a production tokenization system.

## Goals and Objectives

### Primary Goals
1. Automate the deployment of Hokusai token contracts when ML models meet performance criteria
2. Ensure complete traceability between ML models and their corresponding token contracts
3. Provide reliable message processing with proper error handling and retry mechanisms
4. Maintain loose coupling between services through event-driven communication
5. Enable downstream systems to react to deployment events independently

### Success Criteria
- 99.9% uptime for the listener service
- Zero message loss through reliable queue processing
- 100% traceability between MLflow run IDs and deployed contracts
- Sub-5-minute latency from model validation to token deployment
- Complete audit trail for all deployment operations
- All deployment events successfully published to outbound queue

## User Stories and Use Cases

### User Story 1: Data Scientist Model Submission
**As a** data scientist  
**I want** my validated ML model to automatically receive a token contract  
**So that** I can focus on model development without manual deployment steps

**Acceptance Criteria:**
- Model passing validation triggers automatic token deployment
- Deployment status is available through platform UI (via token_deployed events)
- Contract address is linked to my MLflow run

### User Story 2: Platform Administrator Monitoring
**As a** platform administrator  
**I want** to monitor the health and performance of the deployment service  
**So that** I can ensure system reliability and troubleshoot issues

**Acceptance Criteria:**
- Health check endpoint available
- Queue depth metrics exposed for both inbound and outbound queues
- Deployment success/failure rates tracked
- Alert system for failures

### User Story 3: Website Integration
**As the** Hokusai website service  
**I want** to receive notifications when tokens are deployed  
**So that** I can update my database and display deployment status to users

**Acceptance Criteria:**
- Receive structured token_deployed messages
- Messages contain all necessary deployment information
- Can process messages asynchronously
- Can handle message replay for recovery scenarios

## Functional Requirements

### 1. Message Queue Integration
1.1. Connect to Redis message queue using configurable connection string  
1.2. Subscribe to `hokusai:model_ready_queue` for incoming messages  
1.3. Implement reliable message processing using BRPOPLPUSH pattern  
1.4. Handle message acknowledgment and removal after successful processing  
1.5. Publish to `hokusai:token_deployed_queue` for outbound events  

### 2. Message Validation and Processing
2.1. Parse and validate incoming `ModelReadyToDeployMessage` schema  
2.2. Verify required fields: model_id, token_symbol, metrics, MLflow run ID  
2.3. Validate contributor address format when provided  
2.4. Ensure performance improvement meets minimum threshold (>0%)  

### 3. Smart Contract Deployment
3.1. Deploy new HokusaiToken contract for each validated model  
3.2. Set token metadata: name, symbol based on message data  
3.3. Configure TokenManager as controller for minting privileges  
3.4. Store deployment transaction hash for auditability  
3.5. Wait for transaction confirmation before proceeding  

### 4. Registry Integration
4.1. Register deployed token in ModelRegistry contract  
4.2. Link model ID to token contract address  
4.3. Store performance metric type from message  
4.4. Handle registry transaction failures with retry logic  

### 5. Event Emission
5.1. Create `TokenDeployedMessage` with deployment details  
5.2. Include model metadata, contract address, transaction hash  
5.3. Publish message to `hokusai:token_deployed_queue`  
5.4. Ensure message delivery before acknowledging source message  
5.5. Include deployment timestamp and network information  

### 6. Error Handling and Recovery
6.1. Implement exponential backoff for transient failures  
6.2. Move failed messages to dead letter queue after max retries  
6.3. Log all errors with context for debugging  
6.4. Provide mechanism to reprocess DLQ messages  
6.5. Emit failure events for monitoring and alerting  

### 7. Monitoring and Health Checks
7.1. Expose `/health` endpoint with service status  
7.2. Report queue depths (main, processing, DLQ, outbound)  
7.3. Track deployment success/failure metrics  
7.4. Monitor gas usage and costs  
7.5. Track message processing latency  

## Non-Functional Requirements

### Performance
- Process messages within 30 seconds of receipt
- Support processing rate of 100 deployments per hour
- Maintain sub-100ms health check response time
- Handle blockchain congestion gracefully
- Publish outbound messages within 1 second of deployment

### Reliability
- 99.9% service availability
- Zero message loss guarantee
- Automatic recovery from crashes
- Graceful shutdown handling
- At-least-once delivery for all messages

### Security
- Secure storage of deployment private keys
- Encrypted Redis connections in production
- Access control for admin operations
- Audit logging of all deployments
- No sensitive data in event messages

### Scalability
- Horizontal scaling support for high load
- Configurable worker pool size
- Queue-based load distribution
- Resource usage monitoring
- Stateless service design

### Maintainability
- Comprehensive logging with correlation IDs
- Clear error messages and stack traces
- Docker containerization for deployment
- Environment-based configuration
- Message schema versioning

## Technical Architecture Overview

### Component Architecture
```
┌─────────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│ Hokusai ML Platform     │     │      Redis Queue     │     │ Contract Deployer    │
│ - Model Validation      │────▶│ - model_ready_queue  │────▶│ - Queue Consumer     │
│ - Emits Messages        │     │ - Reliable Pattern   │     │ - Web3 Integration   │
└─────────────────────────┘     └─────────────────────┘     │ - Registry Updates   │
                                                             │ - Event Publisher    │
                                                             └──────────────────────┘
                                                                         │
                                                        ┌────────────────┴────────────────┐
                                                        │                                 │
                                                        ▼                                 ▼
                                            ┌──────────────────────┐         ┌─────────────────────┐
                                            │ Blockchain Network   │         │    Redis Queue      │
                                            │ - Token Contracts    │         │ - token_deployed    │
                                            │ - Model Registry     │         └─────────────────────┘
                                            └──────────────────────┘                   │
                                                                                       ▼
                                                                           ┌─────────────────────┐
                                                                           │ Downstream Services │
                                                                           │ - Website           │
                                                                           │ - Analytics         │
                                                                           │ - Monitoring        │
                                                                           └─────────────────────┘
```

### Technology Stack
- **Language**: Python 3.9+ or Node.js 18+
- **Queue**: Redis with reliable queue pattern
- **Blockchain**: Web3.py or Ethers.js
- **Container**: Docker with health checks
- **Monitoring**: Prometheus metrics export

### Message Flow
1. ML Platform validates model and emits message
2. Contract Deployer consumes message from queue
3. Validates message and deployment criteria
4. Deploys token contract to blockchain
5. Registers token in ModelRegistry
6. Publishes token_deployed event
7. Acknowledges and removes source message
8. Downstream services consume deployment events

## Event Schemas

### Inbound: ModelReadyToDeployMessage
```json
{
  "model_id": "model_123",
  "token_symbol": "HKAI-123",
  "metric_name": "accuracy",
  "baseline_value": 0.854,
  "current_value": 0.884,
  "model_name": "enhanced_classifier_v1",
  "model_version": "1.1.0",
  "mlflow_run_id": "run_abc123",
  "improvement_percentage": 3.51,
  "contributor_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d",
  "experiment_name": "iris_classification",
  "tags": {"framework": "tensorflow", "dataset": "iris"},
  "timestamp": "2024-01-27T10:00:00Z",
  "message_version": "1.0"
}
```

### Outbound: TokenDeployedMessage
```json
{
  "event_type": "token_deployed",
  "model_id": "model_123",
  "token_address": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  "token_symbol": "HKAI-123",
  "token_name": "Hokusai Model 123",
  "transaction_hash": "0x7b1203ad2b29d6f24b07b46ec2f970eb37e1e9c8f2a3d4e5f6789012345678ab",
  "registry_transaction_hash": "0x8c2314be3c30e7g35c18c57fd3f081fc48f2f0d9g3b4e5g67890123456789bc",
  "mlflow_run_id": "run_abc123",
  "model_name": "enhanced_classifier_v1",
  "model_version": "1.1.0",
  "deployment_timestamp": "2024-01-27T10:01:30Z",
  "deployer_address": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "network": "polygon",
  "block_number": 12345678,
  "gas_used": "2845632",
  "gas_price": "35000000000",
  "contributor_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d",
  "performance_metric": "accuracy",
  "performance_improvement": 3.51,
  "message_version": "1.0"
}
```

## User Flow Diagrams

### Successful Deployment Flow
```
Start
  │
  ▼
Receive Message from model_ready_queue
  │
  ▼
Validate Message ──── Invalid ───▶ Move to DLQ
  │
  Valid
  │
  ▼
Check Criteria ──── Failed ───▶ Log and Skip
  │
  Passed
  │
  ▼
Deploy Contract ──── Failed ───▶ Retry Logic
  │
  Success
  │
  ▼
Register Token ──── Failed ───▶ Retry Logic
  │
  Success
  │
  ▼
Create TokenDeployedMessage
  │
  ▼
Publish to token_deployed_queue ──── Failed ───▶ Retry Logic
  │
  Success
  │
  ▼
Remove from model_ready_queue
  │
  ▼
End
```

### Error Recovery Flow
```
Message Processing Failed
  │
  ▼
Check Retry Count
  │
  ├── < Max Retries ───▶ Increment Count ───▶ Requeue Message
  │
  └── >= Max Retries ───▶ Move to DLQ ───▶ Emit Failure Event
```

## Success Metrics

### Operational Metrics
- **Deployment Success Rate**: >99% of valid messages result in deployed contracts
- **Processing Latency**: P95 < 30 seconds from message to deployment
- **Queue Depth**: Main queue depth < 100 messages during normal operation
- **DLQ Rate**: <0.1% of messages end up in dead letter queue
- **Event Delivery Rate**: 100% of deployments produce token_deployed events

### Business Metrics
- **Time to Token**: <5 minutes from model validation to tradeable token
- **Deployment Cost**: <$50 per token deployment in gas fees
- **Traceability Rate**: 100% of tokens traceable to MLflow runs
- **Event Consumption**: All events consumed within 1 minute by downstream services

## Dependencies and Constraints

### External Dependencies
- Redis instance for message queues (inbound and outbound)
- Ethereum/Polygon node for blockchain access
- MLflow API for model metadata retrieval (if needed)
- Sufficient ETH/MATIC for gas fees

### Technical Constraints
- Blockchain transaction finality time
- Gas price fluctuations affecting deployment cost
- Network congestion impacting deployment speed
- Private key security requirements
- Message size limits in Redis

### Business Constraints
- Regulatory compliance for token deployment
- Model performance threshold requirements
- Token economics and supply constraints
- Event retention requirements

## Timeline and Milestones

### Phase 1: Core Implementation (Week 1-2)
- Queue consumer implementation
- Message validation logic
- Basic contract deployment
- Error handling framework

### Phase 2: Integration (Week 3-4)
- ModelRegistry integration
- Event publisher implementation
- MLflow metadata enrichment
- Transaction tracking

### Phase 3: Production Readiness (Week 5-6)
- Docker containerization
- Health check endpoints
- Monitoring integration
- Security hardening

### Phase 4: Testing and Deployment (Week 7-8)
- Unit and integration testing
- Load testing
- Security audit
- Production deployment

## Risks and Mitigation Strategies

### Technical Risks

**Risk**: Blockchain network congestion delays deployments  
**Mitigation**: Implement adaptive gas pricing and multiple RPC endpoints

**Risk**: Private key compromise  
**Mitigation**: Use hardware security modules or key management service

**Risk**: Message queue failure causes data loss  
**Mitigation**: Implement Redis persistence and backup strategies

**Risk**: Downstream services can't keep up with events  
**Mitigation**: Implement backpressure and rate limiting

### Operational Risks

**Risk**: Deployment service becomes single point of failure  
**Mitigation**: Deploy multiple instances with load balancing

**Risk**: Gas costs exceed budget  
**Mitigation**: Implement gas price monitoring and deployment throttling

**Risk**: Malformed messages crash the service  
**Mitigation**: Comprehensive validation and error boundaries

### Business Risks

**Risk**: Regulatory changes affect token deployment  
**Mitigation**: Design flexible deployment rules engine

**Risk**: Model quality issues lead to worthless tokens  
**Mitigation**: Enforce strict validation criteria before deployment

## Appendix

### Configuration Parameters
- `REDIS_URL`: Redis connection string
- `WEB3_PROVIDER_URL`: Blockchain RPC endpoint
- `DEPLOYER_PRIVATE_KEY`: Key for deployment transactions
- `MODEL_REGISTRY_ADDRESS`: Registry contract address
- `TOKEN_MANAGER_ADDRESS`: Manager contract address
- `LOG_LEVEL`: Logging verbosity
- `MAX_RETRIES`: Maximum retry attempts
- `DEPLOYMENT_TIMEOUT`: Transaction timeout
- `INBOUND_QUEUE`: Name of model ready queue (default: hokusai:model_ready_queue)
- `OUTBOUND_QUEUE`: Name of token deployed queue (default: hokusai:token_deployed_queue)
- `DLQ_NAME`: Dead letter queue name
- `PROCESSING_QUEUE`: Temporary processing queue name