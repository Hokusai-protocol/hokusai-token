# Product Requirements Document: API Endpoint for Contract Deployments

## Objectives

The primary objective is to implement an HTTP API endpoint that enables the Vercel frontend to trigger ERC20 token deployments for validated ML models. This replaces the current Redis queue-based architecture with a synchronous API suitable for serverless environments, allowing users to deploy tokens directly from the web interface when they click "Deploy Token".

## Personas

### Primary User: ML Model Developer
- Has successfully validated an ML model on the Hokusai platform
- Wants to deploy an ERC20 token to represent their model
- Expects immediate feedback on deployment status
- Needs transparency about gas costs and transaction details

### Secondary User: Frontend Developer
- Integrates with the deployment API from Vercel frontend
- Requires clear API documentation and error handling
- Needs webhook or polling mechanism for deployment status
- Expects consistent response formats and authentication flows

### Tertiary User: Platform Administrator
- Monitors deployment success rates and gas usage
- Manages rate limits and security policies
- Requires audit logs and deployment metrics
- Needs ability to pause/resume deployment service

## Success Criteria

1. **Functional Requirements Met**
   - API endpoint accepts deployment requests from authenticated frontend
   - Successfully deploys HokusaiToken contracts with custom parameters
   - Registers deployed tokens in ModelRegistry
   - Returns deployment status and blockchain transaction details
   - Supports status polling for long-running deployments

2. **Performance Targets**
   - API response time < 500ms for initial request
   - Token deployment completes within 2 minutes on average
   - Support for at least 10 concurrent deployment requests
   - 99% uptime for API availability

3. **Security Requirements**
   - All requests authenticated via JWT tokens
   - Rate limiting prevents abuse (5 deployments per user per hour)
   - Gas price caps prevent excessive costs
   - Audit trail for all deployment attempts

4. **User Experience**
   - Clear error messages for validation failures
   - Real-time deployment progress updates
   - Transaction links to blockchain explorers
   - Estimated gas costs shown before confirmation

## Core Features

### 1. Deployment API Endpoint (POST /api/deployments)

Create a RESTful API endpoint that accepts deployment requests from the frontend.

**Request Schema:**
```typescript
interface DeployTokenRequest {
  model_id: string;              // Unique identifier for the ML model
  user_address: string;           // Ethereum address of the deploying user
  token_name?: string;            // Custom token name (default: "Hokusai {model_id}")
  token_symbol?: string;          // Custom token symbol (default: auto-generated)
  auth_token: string;             // JWT for authentication
}
```

**Response Schema:**
```typescript
interface DeployTokenResponse {
  success: boolean;
  deployment_id: string;          // Unique ID for tracking deployment
  model_id: string;
  estimated_confirmation_time: number;
  estimated_gas_cost: string;
  status_url: string;             // URL to poll for status updates
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}
```

### 2. Status Polling Endpoint (GET /api/deployments/:id/status)

Provide real-time deployment status updates for frontend polling.

**Response Schema:**
```typescript
interface DeploymentStatusResponse {
  deployment_id: string;
  status: 'pending' | 'deploying' | 'registering' | 'completed' | 'failed';
  model_id: string;
  token_address?: string;         // Available once deployed
  token_name?: string;
  token_symbol?: string;
  deployment_tx_hash?: string;    // Blockchain transaction hash
  registry_tx_hash?: string;      // Registry registration transaction
  block_number?: number;
  explorer_url?: string;          // Direct link to explorer
  gas_used?: string;
  gas_price?: string;
  total_cost?: string;
  error?: {
    code: string;
    message: string;
    transaction_hash?: string;
  };
  created_at: string;
  updated_at: string;
}
```

### 3. Smart Contract Modifications

Modify HokusaiToken.sol to accept dynamic name and symbol parameters:

```solidity
constructor(
  string memory _name,
  string memory _symbol,
  address _controller
) ERC20(_name, _symbol) Ownable() {
  controller = _controller;
  emit ControllerSet(_controller);
}
```

### 4. Authentication & Authorization

Implement JWT-based authentication with the following claims:
- User ID
- Ethereum address
- Model ownership/contribution status
- Rate limit tier

Authorization checks:
- User must own or have contributed to the model
- Model must be in 'validated' state
- No existing token for the model

### 5. Model Metadata Retrieval

Integrate with existing data sources to fetch model information:
- MLflow run ID and metrics
- Performance improvements
- Contributor addresses
- Validation timestamp

### 6. Deployment Orchestration

Leverage existing ContractDeployer service with API-specific adaptations:
- Synchronous response with job ID
- Background processing for blockchain operations
- Progress tracking in Redis
- Error recovery and retry logic

### 7. Rate Limiting & Quotas

Implement per-user rate limiting:
- 5 deployments per hour per user
- 20 deployments per day per user
- Configurable limits for premium tiers
- Global circuit breaker for system protection

### 8. Error Handling

Comprehensive error handling with specific codes:
- `AUTH_FAILED`: Authentication failure
- `MODEL_NOT_FOUND`: Model doesn't exist
- `MODEL_NOT_VALIDATED`: Model not yet validated
- `TOKEN_EXISTS`: Token already deployed for model
- `INSUFFICIENT_GAS`: Gas price exceeds limits
- `DEPLOYMENT_FAILED`: Blockchain transaction failed
- `RATE_LIMIT_EXCEEDED`: Too many requests

### 9. Monitoring & Observability

Track key metrics:
- API request/response times
- Deployment success/failure rates
- Gas usage and costs
- Error rates by type
- Queue depths and processing times

### 10. Documentation

Provide comprehensive documentation:
- OpenAPI/Swagger specification
- Authentication guide
- Error code reference
- Integration examples
- Rate limit documentation

## Technical Architecture

### System Components

1. **API Gateway Layer**
   - Express.js routes with TypeScript
   - Request validation middleware
   - Authentication middleware
   - Rate limiting middleware
   - CORS configuration

2. **Business Logic Layer**
   - Deployment orchestration service
   - Model validation service
   - Symbol generation service
   - Gas estimation service

3. **Blockchain Integration Layer**
   - ContractDeployer (existing)
   - ModelRegistryService (existing)
   - Web3 provider management
   - Transaction monitoring

4. **Data Layer**
   - Redis for job tracking
   - Blockchain for permanent storage
   - Memory cache for frequently accessed data

### Deployment Flow

1. Frontend sends POST request to `/api/deployments`
2. API validates JWT and request body
3. Check user authorization and model status
4. Generate unique deployment ID
5. Estimate gas costs
6. Return immediate response with deployment ID
7. Background: Deploy token contract
8. Background: Register in ModelRegistry
9. Background: Update deployment status
10. Frontend polls status endpoint
11. Return final deployment details

## Dependencies

### External Dependencies
- Ethereum blockchain network
- Infura/Alchemy RPC endpoints
- Redis instance
- JWT signing service

### Internal Dependencies
- HokusaiToken smart contract
- ModelRegistry smart contract
- TokenManager smart contract
- ContractDeployer service
- Health monitoring service

## Constraints

### Technical Constraints
- Blockchain confirmation times (1-15 minutes)
- Gas price volatility
- RPC rate limits
- Redis connection limits

### Business Constraints
- Deployment costs must be manageable
- Service must be self-sustaining
- Compliance with security standards
- Audit requirements

## Testing Requirements

### Unit Tests
- Request validation logic
- Authentication/authorization checks
- Symbol generation uniqueness
- Error handling paths
- Rate limiting logic

### Integration Tests
- End-to-end deployment flow
- Frontend API interaction
- Blockchain deployment verification
- Registry registration confirmation
- Status polling accuracy

### Load Tests
- Concurrent deployment handling
- Rate limit enforcement
- Database connection pooling
- Memory usage under load

### Security Tests
- JWT validation
- SQL injection prevention
- Rate limit bypass attempts
- Gas price manipulation
- Replay attack prevention

## Migration Strategy

### Phase 1: Parallel Operation
- Deploy API alongside existing queue system
- Route test deployments through API
- Monitor performance and errors
- Maintain queue system as fallback

### Phase 2: Gradual Migration
- Enable API for select users
- Increase API traffic percentage
- Gather user feedback
- Optimize based on metrics

### Phase 3: Full Migration
- Route all deployments through API
- Deprecate queue-based system
- Archive queue processing code
- Update documentation

## Risk Mitigation

### Identified Risks

1. **High Gas Prices**
   - Mitigation: Implement gas price caps and user warnings
   
2. **API Abuse**
   - Mitigation: Strong rate limiting and authentication
   
3. **Deployment Failures**
   - Mitigation: Comprehensive retry logic and error recovery
   
4. **Data Loss**
   - Mitigation: Blockchain provides permanent record
   
5. **Service Downtime**
   - Mitigation: Health monitoring and auto-recovery

## Success Metrics

- Deployment success rate > 95%
- Average deployment time < 2 minutes
- API uptime > 99.9%
- User satisfaction score > 4.5/5
- Zero security incidents
- Gas costs within budget