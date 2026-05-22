# Smart Contract Integration Guide

This guide is for protocol developers building on top of Hokusai. It covers deployment sequences, role-based access control, parameter bounds, and integration patterns.

## Table of Contents

- [Deployment Sequence](#deployment-sequence)
- [Supplier Allocation Distribution](#supplier-allocation-distribution)
- [Role-Based Access Control](#role-based-access-control)
- [Parameter Bounds](#parameter-bounds)
- [Integration Patterns](#integration-patterns)
- [Code Examples](#code-examples)

## Deployment Sequence

### Full System Deployment

The recommended deployment order for the complete Hokusai system:

```
1. ModelRegistry
   ↓
2. TokenManager (with ModelRegistry address)
   ↓
3. DataContributionRegistry
   ↓
4. DeltaVerifier (with TokenManager and DataContributionRegistry)
   ↓
5. HokusaiAMMFactory (with ModelRegistry, TokenManager, USDC, Treasury)
   ↓
6. UsageFeeRouter (with Treasury address)
   ↓
7. Configure Roles
   ↓
8. Deploy Tokens and Create Pools
```

### Deploying a New Pool

Once the infrastructure contracts are deployed, creating a new token and AMM pool follows this sequence:

```
1. Deploy HokusaiToken via TokenManager
   ↓
2. Register model in ModelRegistry
   ↓
3. Create AMM pool via Factory (automatically grants MINTER_ROLE)
   ↓
4. Add initial liquidity to pool
```

#### Detailed Steps

**Step 1: Deploy Token**

```solidity
TokenManager.InitialParams memory params = TokenManager.InitialParams({
    tokensPerDeltaOne: 5000 * 10**18,                           // parseUnits("5000", 18)
    infrastructureAccrualBps: 7500,                             // 75% infrastructure accrual
    initialOraclePricePerThousandUsd: 0,                        // 6-decimal USD convention
    licenseHash: keccak256(abi.encodePacked("MIT")),            // License hash
    licenseURI: "https://example.com/license",                  // License URI
    governor: governorAddress,                                  // Governor address
    vestingConfig: IHokusaiParams.VestingConfig({
        enabled: false,
        immediateUnlockBps: 10000,
        vestingDurationSeconds: 0,
        cliffSeconds: 0
    })
});

address tokenAddress = tokenManager.deployTokenWithAllocations(
    "model-sentiment-v1",
    "Sentiment Model Token",
    "SENT",
    2_500_000 * 10**18,                                       // supplier allocation
    supplierRecipient,
    10_000_000 * 10**18,                                      // investor allocation cap
    params
);
```

Cap-based deployments separate minting paths at the token level:

- `TokenManager.mintTokens(...)` and AMM buys use `HokusaiToken.mintInvestor(...)` and are limited by `investorAllocation`.
- `TokenManager.mintReward(...)` and vested reward deposits use `HokusaiToken.mintReward(...)` and do not consume investor sale headroom.
- `HokusaiToken.maxSupply()` remains the design-time launch allocation cap for supplier + investor allocations for compatibility, but it is not a global reward mint ceiling on cap-based tokens.

**Step 2: Register Model**

```solidity
// Register with string model ID
modelRegistry.registerStringModel(
    "model-sentiment-v1",           // modelId
    tokenAddress,                    // token address
    "accuracy"                       // metricsType
);
```

**Step 3: Create AMM Pool**

The Factory automatically grants MINTER_ROLE to the newly created pool:

```solidity
address poolAddress = factory.createPoolWithParams(
    "model-sentiment-v1",           // modelId (must match registered model)
    tokenAddress,                    // token address
    100000,                          // crr (10% in ppm)
    25,                              // tradeFee (0.25% in bps)
    7 days,                          // ibrDuration
    25_000 * 10**6,                  // flatCurveThreshold (USDC, 6 decimals)
    10_000                           // flatCurvePrice (USDC, 6 decimals = $0.01)
);
```

**Step 4: Add Initial Liquidity**

```solidity
// Approve USDC transfer
IERC20(usdcAddress).approve(poolAddress, initialReserveAmount);

// Deposit to pool
HokusaiAMM pool = HokusaiAMM(poolAddress);
pool.depositFees(initialReserveAmount);
```

## Supplier Allocation Distribution

Launch tokens created through `deployTokenWithAllocations(...)` do not mint the supplier allocation immediately. The deploy script reads `distributionTiming` from [`scripts/configs/mainnet-launch-tokens.json`](../../scripts/configs/mainnet-launch-tokens.json).

- `pre-launch`: the deploy script calls `tokenManager.distributeModelSupplierAllocation(modelId)` before finishing and verifies that the supplier received the configured amount.
- `post-verification`: the deploy script writes a deferred action to `deployments/mainnet-pending-actions.json` and leaves the supplier allocation undistributed until off-chain model verification is complete.

For the three launch tokens, the default config is `post-verification`. The signing account for the distribution transaction is `TokenManager.owner()`. If ownership has been transferred to a multisig before launch, that multisig signs the transaction; otherwise the deployer EOA does. Record the signer and transaction hash for each token in the mainnet deployment checklist.

Distributed supplier tokens mint directly into the supplier wallet. They are not vesting-vault-locked, count as redeemable circulating supply, and therefore affect AMM spot price and bonding-curve behavior as soon as distribution executes. Treat `distributionTiming` as a pricing decision, not just an accounting or operational toggle.

## Role-Based Access Control

### Core Roles

The Hokusai system uses OpenZeppelin's AccessControl for granular permissions:

#### MINTER_ROLE

**Contract**: TokenManager
**Purpose**: Allows minting and burning of tokens
**Granted to**: AMM pools (automatically by Factory)

```solidity
bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
```

**Granting the role**:
```solidity
// Factory does this automatically, but manual grant:
tokenManager.grantRole(MINTER_ROLE, ammPoolAddress);
```

#### FEE_DEPOSITOR_ROLE

**Contract**: UsageFeeRouter
**Purpose**: Allows depositing API usage fees
**Granted to**: Backend services

```solidity
bytes32 public constant FEE_DEPOSITOR_ROLE = keccak256("FEE_DEPOSITOR_ROLE");
```

**Granting the role**:
```solidity
feeRouter.grantRole(FEE_DEPOSITOR_ROLE, backendServiceAddress);
```

#### RECORDER_ROLE

**Contract**: DataContributionRegistry
**Purpose**: Allows recording data contributions
**Granted to**: DeltaVerifier (for automatic recording)

```solidity
bytes32 public constant RECORDER_ROLE = keccak256("RECORDER_ROLE");
```

**Granting the role**:
```solidity
contributionRegistry.grantRole(RECORDER_ROLE, deltaVerifierAddress);
```

#### VERIFIER_ROLE

**Contract**: DataContributionRegistry
**Purpose**: Allows verifying contributions
**Granted to**: Backend services for verification workflow

```solidity
bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
```

**Granting the role**:
```solidity
contributionRegistry.grantRole(VERIFIER_ROLE, backendServiceAddress);
```

#### GOV_ROLE

**Contract**: HokusaiParams
**Purpose**: Allows updating governance parameters
**Granted to**: DAO governance or multisig

```solidity
bytes32 public constant GOV_ROLE = keccak256("GOV_ROLE");
```

**Granting the role**:
```solidity
params.grantRole(GOV_ROLE, daoGovernanceAddress);
```

### Role Verification

To check if an address has a role:

```solidity
bool hasMinterRole = tokenManager.hasRole(MINTER_ROLE, ammAddress);
bool canDepositFees = feeRouter.hasRole(FEE_DEPOSITOR_ROLE, backendAddress);
```

## Parameter Bounds

All parameters have enforced bounds to ensure system stability and prevent misconfiguration.

### Constant Reserve Ratio (CRR)

**Contract**: HokusaiAMM, HokusaiAMMFactory
**Units**: Parts per million (ppm)
**Range**: 50,000 - 1,000,000 (5% - 100%)

```solidity
uint256 public constant MIN_CRR = 50000;    // 5%
uint256 public constant MAX_CRR = 1000000;  // 100%
```

**Examples**:
- 5% CRR: `50000` (highly volatile, steep bonding curve)
- 10% CRR: `100000` (balanced)
- 50% CRR: `500000` (stable, shallow curve)

### Trade Fee

**Contract**: HokusaiAMM, HokusaiAMMFactory
**Units**: Basis points (bps)
**Range**: 0 - 1,000 (0% - 10%)

```solidity
uint256 public constant MAX_TRADE_FEE = 1000;  // 10%
```

**Examples**:
- 0.25% fee: `25`
- 0.5% fee: `50`
- 1% fee: `100`

### Protocol Fee

**Contract**: HokusaiAMM, HokusaiAMMFactory
**Units**: Basis points (bps)
**Range**: 0 - 5,000 (0% - 50%)

```solidity
uint256 public constant MAX_PROTOCOL_FEE = 5000;  // 50%
```

Protocol fee is taken from deposited fees before they enter the reserve.

**Examples**:
- 5% protocol fee: `500`
- 10% protocol fee: `1000`
- 20% protocol fee: `2000`

### Initial Bonding Round (IBR) Duration

**Contract**: HokusaiAMM, HokusaiAMMFactory
**Units**: Seconds
**Range**: 1 day - 30 days

```solidity
uint256 public constant MIN_IBR_DURATION = 1 days;
uint256 public constant MAX_IBR_DURATION = 30 days;
```

During IBR, only buying is allowed (sells are disabled).

**Examples**:
- 7 days: `7 days` or `604800`
- 14 days: `14 days` or `1209600`
- 30 days: `30 days` or `2592000`

### Max Trade Size

**Contract**: HokusaiAMM
**Units**: Basis points (bps) of reserve
**Range**: 0 - 5,000 (0% - 50%)
**Default**: 2,000 (20%)

```solidity
uint256 public constant MAX_TRADE_BPS_LIMIT = 5000;  // 50%
uint256 public maxTradeBps = 2000;  // Default 20%
```

Prevents single trades from moving the price too dramatically.

### HokusaiParams Bounds

**Contract**: HokusaiParams
**Units**: Various

```solidity
// Tokens per DeltaOne (1% improvement)
uint256 public constant MIN_TOKENS_PER_DELTA = 100;
uint256 public constant MAX_TOKENS_PER_DELTA = 100000;

// Infrastructure markup (on top of base API costs)
uint16 public constant MAX_INFRA_MARKUP_BPS = 1000;  // 10%
```

## Integration Patterns

### Pattern 1: Deploying a Pool for an Existing Token

If you have an existing HokusaiToken and want to create an AMM pool:

```solidity
// 1. Ensure token is registered
require(modelRegistry.isRegisteredString(modelId), "Model not registered");

// 2. Create pool via Factory
address poolAddress = factory.createPoolWithParams(
    modelId,
    existingTokenAddress,
    100000,     // 10% CRR
    25,         // 0.25% trade fee
    500,        // 5% protocol fee
    7 days      // IBR duration
);

// 3. Factory automatically grants MINTER_ROLE to pool
// No manual role grant needed!

// 4. Add initial liquidity
IERC20(usdcAddress).approve(poolAddress, 10000e6);  // 10,000 USDC
HokusaiAMM(poolAddress).depositFees(10000e6);
```

### Pattern 2: Integrating with External Contracts

External contracts can interact with HokusaiAMM for trading:

```solidity
contract MyTradingContract {
    HokusaiAMM public pool;
    IERC20 public usdc;

    function buyTokens(uint256 usdcAmount) external {
        // 1. User must approve this contract to spend USDC
        usdc.transferFrom(msg.sender, address(this), usdcAmount);

        // 2. Approve pool to spend USDC
        usdc.approve(address(pool), usdcAmount);

        // 3. Calculate minimum tokens with 1% slippage
        uint256 expectedTokens = pool.calculateBuyReturn(usdcAmount);
        uint256 minTokens = expectedTokens * 99 / 100;

        // 4. Execute buy
        uint256 tokensReceived = pool.buy(
            usdcAmount,
            minTokens,
            msg.sender,           // Send tokens to user
            block.timestamp + 300 // 5 minute deadline
        );
    }
}
```

### Pattern 3: Reading Pool State Efficiently

Use `getPoolState()` to fetch multiple values in a single call:

```solidity
(
    uint256 reserve,
    uint256 supply,
    uint256 spotPrice,
    uint256 crr,
    uint256 tradeFee,
    uint16 protocolFee
) = pool.getPoolState();

// Now you have all pool metrics without multiple RPC calls
```

### Pattern 4: Batch Minting Rewards

For distributing rewards to multiple contributors:

```solidity
address[] memory recipients = new address[](3);
recipients[0] = contributor1;
recipients[1] = contributor2;
recipients[2] = contributor3;

uint256[] memory amounts = new uint256[](3);
amounts[0] = 1000e18;
amounts[1] = 2000e18;
amounts[2] = 1500e18;

// Requires MINTER_ROLE
tokenManager.batchMint(modelId, recipients, amounts);
```

## Code Examples

### Example 1: Complete Pool Deployment

See [docs/examples/solidity/deploy-pool.sol](../examples/solidity/deploy-pool.sol) for a complete example.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/ITokenManager.sol";
import "./interfaces/IModelRegistry.sol";
import "./interfaces/IHokusaiAMMFactory.sol";

contract PoolDeployer {
    ITokenManager public tokenManager;
    IModelRegistry public modelRegistry;
    IHokusaiAMMFactory public factory;
    address public usdc;

    constructor(
        address _tokenManager,
        address _modelRegistry,
        address _factory,
        address _usdc
    ) {
        tokenManager = ITokenManager(_tokenManager);
        modelRegistry = IModelRegistry(_modelRegistry);
        factory = IHokusaiAMMFactory(_factory);
        usdc = _usdc;
    }

    function deployCompletePool(
        string memory modelId,
        string memory tokenName,
        string memory tokenSymbol,
        uint256 supplierAllocation,
        address supplierRecipient,
        uint256 investorAllocation,
        TokenManager.InitialParams memory params,
        uint256 crr,
        uint256 tradeFee,
        uint256 ibrDuration,
        uint256 flatCurveThreshold,
        uint256 flatCurvePrice,
        uint256 initialLiquidity
    ) external returns (address tokenAddress, address poolAddress) {
        // 1. Deploy token
        tokenAddress = tokenManager.deployTokenWithAllocations(
            modelId,
            tokenName,
            tokenSymbol,
            supplierAllocation,
            supplierRecipient,
            investorAllocation,
            params
        );

        // 2. Register model
        modelRegistry.registerStringModel(modelId, tokenAddress, "accuracy");

        // 3. Create pool (Factory grants MINTER_ROLE automatically)
        poolAddress = factory.createPoolWithParams(
            modelId,
            tokenAddress,
            crr,
            tradeFee,
            ibrDuration,
            flatCurveThreshold,
            flatCurvePrice
        );

        // 4. Add initial liquidity
        IERC20(usdc).transferFrom(msg.sender, address(this), initialLiquidity);
        IERC20(usdc).approve(poolAddress, initialLiquidity);
        IHokusaiAMM(poolAddress).depositFees(initialLiquidity);

        // 5. Optional supplier mint if configured for pre-launch timing
        tokenManager.distributeModelSupplierAllocation(modelId);

        return (tokenAddress, poolAddress);
    }
}
```

### Example 2: Safe Trading with Slippage Protection

```solidity
function safeBuy(
    address poolAddress,
    uint256 usdcAmount,
    uint256 slippageBps  // e.g., 50 = 0.5%
) external returns (uint256 tokensReceived) {
    HokusaiAMM pool = HokusaiAMM(poolAddress);

    // Calculate expected tokens
    uint256 expectedTokens = pool.calculateBuyReturn(usdcAmount);

    // Apply slippage tolerance
    uint256 minTokens = expectedTokens * (10000 - slippageBps) / 10000;

    // Transfer USDC from user
    IERC20(pool.reserveToken()).transferFrom(msg.sender, address(this), usdcAmount);

    // Approve pool
    IERC20(pool.reserveToken()).approve(poolAddress, usdcAmount);

    // Execute trade
    tokensReceived = pool.buy(
        usdcAmount,
        minTokens,
        msg.sender,
        block.timestamp + 300
    );

    require(tokensReceived >= minTokens, "Slippage exceeded");
}
```

## Gas Estimates

Typical gas costs for common operations (on Ethereum mainnet):

| Operation | Gas Cost | Notes |
|-----------|----------|-------|
| Deploy Token | ~1,500,000 | Including HokusaiParams deployment |
| Register Model | ~50,000 | |
| Create Pool | ~3,500,000 | Most expensive operation |
| Buy Tokens | ~200,000 | Varies with token supply |
| Sell Tokens | ~250,000 | Slightly higher due to burn |
| Deposit Fees | ~100,000 | |
| Batch Mint (10 recipients) | ~300,000 | Scales linearly |

**Note**: Gas costs are estimates and vary based on network conditions and contract state.

## Common Errors

### "CRR out of bounds"

Your CRR must be between 50,000 (5%) and 500,000 (50%) ppm.

```solidity
// ❌ Wrong
factory.createPoolWithParams(modelId, token, 1000, ...);  // Too low

// ✅ Correct
factory.createPoolWithParams(modelId, token, 100000, ...);  // 10%
```

### "Trade fee too high"

Trade fee cannot exceed 1,000 bps (10%).

```solidity
// ❌ Wrong
factory.createPoolWithParams(modelId, token, 100000, 1500, ...);

// ✅ Correct
factory.createPoolWithParams(modelId, token, 100000, 25, ...);  // 0.25%
```

### "Not authorized"

You need the appropriate role. Check with `hasRole()`:

```solidity
bool canMint = tokenManager.hasRole(MINTER_ROLE, msg.sender);
require(canMint, "Not authorized");
```

### "Model already registered"

Each model ID can only be registered once:

```solidity
// Check before registering
if (!modelRegistry.isRegisteredString(modelId)) {
    modelRegistry.registerStringModel(modelId, token, metricsType);
}
```

## Next Steps

- [Backend Service Integration Guide](./backend-services.md) - Learn about fee collection and ML verification
- [Frontend Integration Guide](./frontend-development.md) - Build UIs with view functions
- [API Reference: HokusaiAMM](../api-reference/contracts/HokusaiAMM.md) - Detailed contract documentation
- [API Reference: HokusaiAMMFactory](../api-reference/contracts/HokusaiAMMFactory.md) - Factory contract reference
