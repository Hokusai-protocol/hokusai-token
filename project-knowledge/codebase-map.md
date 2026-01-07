# Codebase Knowledge Map
_Last updated: 2026-01-07_

## Components & Services

### Smart Contracts
- HokusaiToken: ERC20 with controller-based mint/burn, dynamic name/symbol constructor [details: features/api-endpoint-contract-deploys/prd.md]
- ModelRegistry: Maps model IDs to token addresses, provides bidirectional lookup [details: features/contract-deploy-listener/prd.md]
- TokenManager: Exclusive controller for minting/burning operations, integrates with ModelRegistry, deploys tokens with 0.01 ETH fee [details: features/add-params-model-to-tokens/investigation.md]
- DeltaVerifier: Calculates token rewards based on ML model performance metrics, uses baseRewardRate=1000, minImprovementBps=100, automatically records contributions in DataContributionRegistry [details: features/data-contribution-registry/plan.md]
- HokusaiParams: Per-token governance-adjustable parameters module with tokensPerDeltaOne, infraMarkupBps, licenseRef [details: features/add-params-model-to-tokens/prd.md]
- DataContributionRegistry: Tracks data contributions with attribution weights, supports verification workflow, provides paginated queries [details: features/data-contribution-registry/plan.md]

### Backend Services
- contract-deployer (Queue Mode): Service monitoring Redis for model_ready_to_deploy events, deploys tokens automatically [details: features/contract-deploy-listener/prd.md]
- contract-deployer (API Mode): RESTful endpoints for frontend-initiated deployments, JWT auth, rate limiting [details: features/api-endpoint-contract-deploys/prd.md]

## Documented Flows

### Contract Deploy Listener Flow (Queue-Based)
- Redis queue → message validation → deploy HokusaiToken → register in ModelRegistry → publish token_deployed event [details: features/contract-deploy-listener/prd.md]

### API Deployment Flow (HTTP-Based)
- Frontend POST → JWT validation → deployment job creation → background blockchain ops → status polling [details: features/api-endpoint-contract-deploys/prd.md]

### Contribution Recording Flow (Automatic)
- ML pipeline submits evaluation → DeltaVerifier validates and calculates rewards → TokenManager mints tokens → DataContributionRegistry records contribution with attribution weights → Backend queries for analytics [details: features/data-contribution-registry/plan.md]

## Architecture Patterns

### Parameter Management Pattern (planned)
- Separate HokusaiParams contract per token for governance-adjustable values
- Immutable pointer from token to params ensures security with flexibility
- Dynamic reading allows immediate parameter effect without contract upgrades [details: features/add-params-model-to-tokens/flow-mapping.md]

### Dual Deployment Modes
- Queue-based async processing via Redis for ML platform integration
- HTTP API for direct frontend-initiated deployments
- Both modes share core deployment logic and blockchain services

### Event-Driven Architecture
- Redis queues for async message passing between services (hokusai:model_ready_queue, hokusai:token_deployed_queue)
- BRPOPLPUSH pattern for reliable message processing with DLQ support
- Optional webhooks for deployment completion notifications

### Controller Pattern
- TokenManager acts as sole controller for all HokusaiToken mint/burn operations
- Prevents direct token manipulation, enforces business logic centrally

### Registry Pattern
- ModelRegistry provides central lookup for all model-token associations
- DataContributionRegistry tracks all data contributions with attribution weights
- Prevents duplicate registrations, enables efficient queries

### Role-Based Access Control (RBAC)
- DataContributionRegistry uses OpenZeppelin AccessControl
- RECORDER_ROLE: Granted to DeltaVerifier for automatic contribution recording
- VERIFIER_ROLE: Granted to backend service for contribution verification
- DEFAULT_ADMIN_ROLE: Can grant/revoke roles, transfer admin rights

## Tech Stack & Conventions

### Smart Contracts
- Solidity with OpenZeppelin libraries for ERC20 and access control
- Hardhat for development, testing, and deployment
- TypeScript for deployment scripts and tests

### Backend Services
- Node.js/TypeScript for service implementation
- Express.js for API routes with middleware pattern
- Ethers.js for Web3 interactions
- Redis for job queues, status tracking, and rate limiting

## External Integrations

### Blockchain Networks
- Ethereum/Polygon for contract deployment
- Multiple RPC endpoints (Infura/Alchemy) for redundancy
- Adaptive gas pricing for network congestion

### ML Platform
- MLflow for model metadata and run tracking
- Redis queues for event communication with ML pipeline
- Performance metrics validation before tokenization

### Optional Integrations
- Webhook notifications for deployment events (configurable)
- CORS support for frontend domains

## Database Schema Insights

### Redis Key Patterns
- Queue keys: hokusai:model_ready_queue, hokusai:token_deployed_queue, hokusai:dlq
- Deployment tracking: deployment:status:{id}, deployment:queue:{id}
- User tracking: user:deployments:{address}
- Model tracking: model:deployment:{modelId}
- Processing queue for BRPOPLPUSH reliability

### On-chain Storage
- Model ID → Token Address mapping in ModelRegistry
- Token metadata (name, symbol, controller) in HokusaiToken
- Performance metrics type stored with model registration

## API Patterns

### RESTful Endpoints
- POST /api/deployments - Create deployment with authentication
- GET /api/deployments/:id/status - Poll for deployment status
- GET /health - Service health checks with component status
- GET /health/detailed - Comprehensive health information

### Authentication
- API key authentication for service operations (configurable list)
- JWT tokens with user claims (planned for production)
- Rate limiting per user (5/hour, 20/day)

## Testing Patterns

### Contract Testing
- Hardhat test suite with ethers.js
- Unit tests for each contract function
- Integration tests for contract interactions
- Gas usage optimization tests

### Service Testing
- Jest for unit and integration tests
- Mocked Redis and Web3 for isolated testing
- End-to-end tests on testnet
- Load testing for 100 deployments/hour throughput

## Deployment Configuration

### Environment Variables
- REDIS_URL/REDIS_HOST/REDIS_PORT: Redis connection
- RPC_URL/RPC_URLS: Blockchain RPC endpoints
- DEPLOYER_PRIVATE_KEY: Key for deployment transactions
- MODEL_REGISTRY_ADDRESS: Registry contract address
- TOKEN_MANAGER_ADDRESS: Manager contract address
- WEBHOOK_URL/WEBHOOK_SECRET: Optional webhook config
- API key and JWT configuration for authentication

### Docker Support
- Multi-stage builds for optimized images
- Health check endpoints for container orchestration
- Environment-specific configurations

## Service Modes

### Queue Listener Mode (src/index.ts)
- Continuously polls Redis queues for deployment requests
- Processes model_ready_to_deploy messages
- Publishes token_deployed events
- Runs health check server on configured port

### API Server Mode (src/server.ts)
- Provides HTTP endpoints for deployment requests
- Synchronous response with job tracking
- Background processing for blockchain operations
- Rate limiting and authentication middleware
- **Port 8002 default for AWS ECS deployment** [details: features/containerize-contract-api-2025-09-05/summary.md]

## AWS Deployment Configuration

### ECS Containerization
- Multi-stage Docker build with Alpine Linux base for <200MB image size
- Non-root user execution with dumb-init for signal handling
- Flexible PORT configuration via environment variable (default: 8002)
- API server mode in Dockerfile CMD for production deployment

### AWS SSM Integration
- Runtime secret retrieval from Parameter Store under /hokusai/development/contracts/
- Automatic retry logic with exponential backoff for parameter fetching
- Support for both SecureString and String parameter types
- Async configuration loading in production environment [details: features/containerize-contract-api-2025-09-05/summary.md]

### Deployment Automation
- ECR push script with versioning (latest, git hash, semantic version)
- ECS deployment script with health check validation and automatic rollback
- CloudWatch dashboard configuration with key metrics and alarms
- Comprehensive deployment tests covering containerization aspects

## Notes
- Contract deployment service supports both queue-based (async) and API-based (sync) deployments
- All deployments require model validation and performance thresholds (>0% improvement)
- Comprehensive error handling with retry logic and dead letter queues for reliability
- Both service modes can run simultaneously or independently based on needs
- Webhooks are optional for deployment notifications, not a replacement for queues