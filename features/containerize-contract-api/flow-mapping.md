# Contract API Service Containerization & Deployment Flow Mapping

## 1. Docker Build Process Flow

### Multi-Stage Build Pipeline
```
Stage 1: Dependencies (node:18-alpine AS deps)
├── Copy package*.json files
├── npm ci (install production dependencies)
└── Cache node_modules for final stage

Stage 2: Builder (node:18-alpine AS builder)
├── Copy all source files
├── Copy node_modules from deps stage
├── npm run build (TypeScript compilation)
└── Generate dist/ directory

Stage 3: Production (node:18-alpine)
├── Install dumb-init (for signal handling)
├── Create non-root user 'appuser'
├── Copy production dependencies from deps
├── Copy compiled dist/ from builder
├── Set ownership to appuser
├── Configure health check
├── Expose ports 3001 (API) and 9091 (metrics)
└── Run with dumb-init as PID 1
```

### Build Optimization Features
- Alpine Linux base for minimal size
- Multi-stage build reduces final image to ~150MB
- Production-only dependencies in final image
- Non-root user for security
- dumb-init for proper signal handling in containers

## 2. Container Startup & Initialization Flow

### Startup Sequence (API Mode - src/server.ts)
```
1. Process Initialization
   ├── Load environment variables
   ├── Validate configuration via env.validation.ts
   └── Set up Winston logger

2. Service Dependencies
   ├── Initialize Redis client
   │   ├── Connect to REDIS_URL
   │   ├── Set up connection error handlers
   │   └── Configure retry strategy
   ├── Initialize Blockchain Provider
   │   ├── Connect to RPC endpoints
   │   ├── Load deployer wallet
   │   └── Verify network connectivity
   └── Load Contract Instances
       ├── ModelRegistry at MODEL_REGISTRY_ADDRESS
       └── TokenManager at TOKEN_MANAGER_ADDRESS

3. Express Server Setup
   ├── Configure middleware stack
   │   ├── Helmet (security headers)
   │   ├── CORS (if enabled)
   │   ├── Body parser
   │   ├── Request ID generation
   │   └── Rate limiting
   ├── Mount routes
   │   ├── /health endpoints
   │   ├── /api/deployments routes
   │   └── Error handling middleware
   └── Start HTTP server on PORT (3001)

4. Graceful Shutdown Handlers
   ├── SIGTERM handler
   ├── SIGINT handler
   └── Cleanup sequence
       ├── Stop accepting new requests
       ├── Finish processing current requests
       ├── Close Redis connections
       └── Exit process
```

## 3. Health Check Flow

### Docker Health Check
```
HEALTHCHECK Command (every 30s)
├── Execute: curl -f http://localhost:3001/health
├── Timeout: 3 seconds
├── Retries: 3 attempts
└── Container marked unhealthy if fails
```

### Application Health Endpoints
```
GET /health (Basic Liveness)
├── Return 200 OK
└── Response: { status: 'ok', timestamp }

GET /health/ready (Readiness Check)
├── Check Redis connectivity
│   ├── Execute PING command
│   └── Verify response
├── Check blockchain provider
│   ├── Get latest block number
│   └── Verify response
├── Check contract accessibility
│   ├── Call view function on ModelRegistry
│   └── Verify response
└── Return aggregated status

GET /health/detailed (Comprehensive)
├── All readiness checks
├── Memory usage statistics
├── Uptime information
├── Configuration status
└── Component-level health details
```

## 4. AWS ECS Deployment Flow

### Infrastructure Setup
```
1. ECR Repository
   ├── Repository: 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts
   ├── Image tagging: latest, git-sha, semantic version
   └── Lifecycle policy for old image cleanup

2. ECS Task Definition
   ├── Task Role (IAM)
   │   ├── SSM:GetParameter permissions
   │   ├── CloudWatch:PutMetricData
   │   └── Logs:CreateLogStream
   ├── Container Definition
   │   ├── Image: ECR repository URL
   │   ├── Memory: 512MB (soft), 1024MB (hard)
   │   ├── CPU: 256 units
   │   ├── Port mappings: 3001 (API), 9091 (metrics)
   │   └── Environment variables from SSM
   └── CloudWatch Log Configuration

3. ECS Service Configuration
   ├── Cluster: hokusai-development
   ├── Service: hokusai-contracts-development
   ├── Task Definition: Latest revision
   ├── Desired Count: 2 (for HA)
   ├── Deployment Configuration
   │   ├── Min healthy: 100%
   │   ├── Max percent: 200%
   │   └── Rolling update strategy
   └── Service Discovery
       └── DNS: contracts.hokusai-development.local

4. Load Balancer Integration
   ├── Target Group: Port 3001
   ├── Health Check Path: /health/ready
   ├── Health Check Interval: 30s
   ├── Unhealthy Threshold: 2
   └── Deregistration Delay: 30s

5. Route 53 DNS
   └── contracts.hokus.ai → ALB endpoint
```

### Deployment Process
```
1. Build & Push
   ├── docker build -t contracts-api .
   ├── docker tag → ECR repository
   ├── aws ecr get-login-password
   ├── docker push to ECR
   └── Tag with version and latest

2. Update ECS Service
   ├── aws ecs update-service --force-new-deployment
   ├── ECS creates new tasks with new image
   ├── Health checks validate new tasks
   ├── Traffic shifts to new tasks
   └── Old tasks terminated

3. Monitoring & Validation
   ├── CloudWatch dashboard updates
   ├── Check health endpoint externally
   └── Verify API functionality
```

## 5. Secret Management Flow (AWS SSM)

### Parameter Store Structure
```
/hokusai/development/contracts/
├── deployer_key (SecureString)
├── token_manager_address (String)
├── model_registry_address (String)
├── rpc_endpoint (String)
├── redis_url (SecureString)
├── api_keys (StringList)
└── jwt_secret (SecureString)
```

### Secret Retrieval Flow
```
Container Startup
├── ECS Task Role authenticates with AWS
├── Environment variables reference SSM paths
├── ECS Agent fetches parameters
│   ├── Decrypt SecureString types
│   └── Cache for task lifetime
├── Values injected as environment variables
└── Application reads from process.env
```

### Secret Rotation Process
```
1. Update SSM Parameter
   └── aws ssm put-parameter --overwrite

2. Force New Deployment
   └── aws ecs update-service --force-new-deployment

3. New tasks fetch updated secrets
4. Old tasks continue with cached values
5. Gradual rollout completes rotation
```

## 6. API Request Flow (Deployed)

### External Request Journey
```
Client Request
├── DNS Resolution (contracts.hokus.ai)
├── HTTPS to Application Load Balancer
├── ALB routes to healthy ECS task
├── Container receives request on port 3001
│
├── Express Middleware Pipeline
│   ├── Request ID assignment
│   ├── Helmet security headers
│   ├── CORS validation (if origin allowed)
│   ├── Rate limiting check (Redis)
│   │   ├── Check user limits (5/hour, 20/day)
│   │   └── Reject if exceeded
│   ├── Authentication middleware
│   │   ├── Extract API key or JWT
│   │   ├── Validate against configured keys
│   │   └── Attach user context to request
│   └── Request body parsing & validation
│
├── Route Handler (/api/deployments)
│   ├── Validate request schema (Joi)
│   ├── Check model prerequisites
│   ├── Create deployment job in Redis
│   ├── Queue blockchain transaction
│   └── Return job ID for polling
│
├── Background Processing
│   ├── Deploy contract on blockchain
│   ├── Register in ModelRegistry
│   ├── Update job status in Redis
│   └── Emit metrics to CloudWatch
│
└── Response to Client
    ├── Add security headers
    ├── Format JSON response
    └── Log to CloudWatch
```

### Status Polling Flow
```
GET /api/deployments/:id/status
├── Retrieve job from Redis
├── Check blockchain confirmation
├── Return current status
│   ├── pending
│   ├── processing
│   ├── completed
│   └── failed
└── Include transaction details if completed
```

## Key Integration Points

### CloudWatch Logging
```
Log Streams Structure
├── /ecs/hokusai-contracts/{task-id}
├── Structured JSON logs
├── Log levels: error, warn, info, debug
└── Automatic metric extraction
```

### Monitoring & Alerts
```
CloudWatch Metrics
├── API request count by endpoint
├── Response time percentiles
├── Error rates by type
├── Redis connection status
├── Blockchain RPC latency
└── Container resource utilization

Alarms
├── High error rate (>1%)
├── Unhealthy task count
├── High memory utilization (>80%)
└── API response time (>2s p99)
```

### Service Dependencies
```
Internal Services
├── Redis (ElastiCache)
│   ├── Connection via REDIS_URL
│   └── Used for rate limiting & job tracking
└── Blockchain RPC
    ├── Multiple endpoints for redundancy
    └── Automatic failover

External Services
├── Model Registry Contract
├── Token Manager Contract
└── Blockchain Network (Polygon/Ethereum)
```

## Deployment Checklist

### Pre-Deployment
- [ ] Verify Docker image builds locally
- [ ] Run local integration tests
- [ ] Set all required SSM parameters
- [ ] Configure ALB target group
- [ ] Update Route 53 DNS records

### Deployment
- [ ] Push Docker image to ECR
- [ ] Update ECS task definition
- [ ] Force new deployment
- [ ] Monitor CloudWatch logs
- [ ] Verify health checks passing

### Post-Deployment
- [ ] Test API endpoints externally
- [ ] Verify CloudWatch metrics flowing
- [ ] Check error rates and latency
- [ ] Confirm rate limiting working
- [ ] Test graceful shutdown behavior