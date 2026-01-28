# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

## Common Commands
Common prompts: 
@~/.claude/my-common-prompts.md

For this repo, use the "Hokusai smart contracts" project in Linear to pull the backlog list. 


### Essential Commands
- `npm test` - Run the Hardhat test suite
- `npx hardhat compile` - Compile all smart contracts
- `npx hardhat test` - Run tests (same as npm test)
- `npx hardhat test test/token.test.js` - Run a specific test file
- `npx hardhat node` - Start a local Hardhat network
- `npx hardhat run scripts/deploy.js --network localhost` - Deploy contracts to local network

### Hardhat Tasks
- `npx hardhat help` - List all available Hardhat tasks
- `npx hardhat clean` - Clear cache and artifacts
- `npx hardhat coverage` - Generate test coverage report

## Architecture Overview

### Smart Contract Architecture

The project implements a token system where ERC20 tokens are linked to ML models:

1. **HokusaiToken** - ERC20 token with controller-based minting/burning
   - Only the designated controller can mint/burn tokens
   - Implements standard ERC20 with additional access control

2. **ModelRegistry** - Maps model IDs to token addresses
   - Central registry for all model-token associations
   - Allows querying token address by model ID

3. **TokenManager** - Controller contract managing token operations
   - Has exclusive mint/burn privileges on HokusaiToken
   - Integrates with ModelRegistry to validate operations
   - Implements business logic for token distribution

4. **BurnAuction** - Handles token burning mechanisms

### Key Design Patterns

- **Controller Pattern**: TokenManager acts as the sole controller for minting/burning operations
- **Registry Pattern**: ModelRegistry provides a central lookup for model-token mappings
- **Separation of Concerns**: Token logic (HokusaiToken) is separated from management logic (TokenManager)

### Project Structure

- `/contracts` - Solidity smart contracts
- `/scripts` - Deployment and operational scripts
- `/test` - Test files using Hardhat testing framework
- `/tools` - Development workflow automation (Linear integration, GitHub automation)

### Token Metadata Design

The project uses a hybrid on-chain/off-chain approach for token metadata:
- On-chain: Essential data like model ID and token address
- Off-chain: Detailed ML model metrics and performance data
- See `Hokusai_Token_Metadata.md` for complete specification

### Development Workflow

The `/tools` directory contains workflow automation for:
- Fetching tasks from Linear project management
- Creating feature branches
- Generating PRDs and design specs from templates
- Automating pull request creation

## Deployment

### Docker Image Architecture Requirements

**IMPORTANT**: When building Docker images for AWS ECS Fargate deployment, you MUST build for the AMD64 architecture, not ARM64.

- Local Mac development uses ARM64 (Apple Silicon)
- AWS ECS Fargate defaults to x86_64/AMD64 when RuntimePlatform is null
- Building ARM64 images on Mac will result in "exec format error" when deployed to ECS

**Always use this command for ECS deployments**:
```bash
docker buildx build --platform linux/amd64 -t <image-name> --load .
```

### ECS Services

The project has two separate ECS services:

1. **hokusai-contracts-development** (API Service)
   - ECR: `932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts`
   - Dockerfile CMD: `["node", "dist/server.js"]`
   - Build/deploy scripts: `services/contract-deployer/scripts/build-and-push.sh` and `deploy.sh`

2. **hokusai-monitor-testnet** (Monitoring Service)
   - ECR: `932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai-monitoring`
   - Dockerfile CMD: `["node", "dist/monitoring-server.js"]`
   - Implements event-driven AMM pool monitoring with RPC optimizations