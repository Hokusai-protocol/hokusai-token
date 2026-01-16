// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../../../contracts/TokenManager.sol";
import "../../../contracts/ModelRegistry.sol";
import "../../../contracts/HokusaiAMMFactory.sol";
import "../../../contracts/HokusaiAMM.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PoolDeployer
 * @notice Example contract demonstrating complete pool deployment
 *
 * This example shows how to:
 * 1. Deploy a new HokusaiToken via TokenManager
 * 2. Register the model in ModelRegistry
 * 3. Create an AMM pool via Factory (automatically grants MINTER_ROLE)
 * 4. Add initial liquidity to the pool
 *
 * Usage:
 *   PoolDeployer deployer = new PoolDeployer(
 *       tokenManagerAddress,
 *       modelRegistryAddress,
 *       factoryAddress,
 *       usdcAddress
 *   );
 *
 *   (address token, address pool) = deployer.deployCompletePool(
 *       "model-sentiment-v1",
 *       "Sentiment Model Token",
 *       "SENT",
 *       1000000 * 10**18,  // 1M tokens initial supply
 *       100000,            // 10% CRR
 *       25,                // 0.25% trade fee
 *       500,               // 5% protocol fee
 *       7 days,            // 7 day IBR
 *       10000 * 10**6      // $10,000 initial liquidity
 *   );
 */
contract PoolDeployer {
    TokenManager public immutable tokenManager;
    ModelRegistry public immutable modelRegistry;
    HokusaiAMMFactory public immutable factory;
    IERC20 public immutable usdc;

    event PoolDeploymentComplete(
        string indexed modelId,
        address indexed tokenAddress,
        address indexed poolAddress,
        uint256 initialLiquidity
    );

    constructor(
        address _tokenManager,
        address _modelRegistry,
        address _factory,
        address _usdc
    ) {
        require(_tokenManager != address(0), "Invalid TokenManager");
        require(_modelRegistry != address(0), "Invalid ModelRegistry");
        require(_factory != address(0), "Invalid Factory");
        require(_usdc != address(0), "Invalid USDC");

        tokenManager = TokenManager(_tokenManager);
        modelRegistry = ModelRegistry(_modelRegistry);
        factory = HokusaiAMMFactory(_factory);
        usdc = IERC20(_usdc);
    }

    /**
     * @notice Deploy a complete pool with token, registration, and liquidity
     * @param modelId String identifier for the model
     * @param tokenName Token name
     * @param tokenSymbol Token symbol
     * @param initialSupply Total token supply (18 decimals)
     * @param crr Constant Reserve Ratio in ppm (50000-500000)
     * @param tradeFee Trade fee in bps (0-1000)
     * @param protocolFee Protocol fee in bps (0-5000)
     * @param ibrDuration IBR duration in seconds (1 day - 30 days)
     * @param initialLiquidity Initial USDC liquidity (6 decimals)
     * @return tokenAddress Address of deployed token
     * @return poolAddress Address of created pool
     */
    function deployCompletePool(
        string memory modelId,
        string memory tokenName,
        string memory tokenSymbol,
        uint256 initialSupply,
        uint256 crr,
        uint256 tradeFee,
        uint16 protocolFee,
        uint256 ibrDuration,
        uint256 initialLiquidity
    ) external returns (address tokenAddress, address poolAddress) {
        // Step 1: Deploy token via TokenManager
        tokenAddress = tokenManager.deployToken(
            modelId,
            tokenName,
            tokenSymbol,
            initialSupply
        );

        // Step 2: Register model in ModelRegistry
        modelRegistry.registerStringModel(modelId, tokenAddress, "accuracy");

        // Step 3: Create AMM pool (Factory automatically grants MINTER_ROLE)
        poolAddress = factory.createPoolWithParams(
            modelId,
            tokenAddress,
            crr,
            tradeFee,
            protocolFee,
            ibrDuration
        );

        // Step 4: Add initial liquidity
        // Transfer USDC from caller to this contract
        require(
            usdc.transferFrom(msg.sender, address(this), initialLiquidity),
            "USDC transfer failed"
        );

        // Approve pool to spend USDC
        usdc.approve(poolAddress, initialLiquidity);

        // Deposit to pool
        HokusaiAMM pool = HokusaiAMM(poolAddress);
        pool.depositFees(initialLiquidity);

        emit PoolDeploymentComplete(modelId, tokenAddress, poolAddress, initialLiquidity);

        return (tokenAddress, poolAddress);
    }

    /**
     * @notice Helper to check if all parameters are valid before deployment
     * @param crr Constant Reserve Ratio to validate
     * @param tradeFee Trade fee to validate
     * @param protocolFee Protocol fee to validate
     * @param ibrDuration IBR duration to validate
     * @return valid True if all parameters are valid
     * @return reason Error message if invalid
     */
    function validateParameters(
        uint256 crr,
        uint256 tradeFee,
        uint16 protocolFee,
        uint256 ibrDuration
    ) external pure returns (bool valid, string memory reason) {
        // CRR bounds: 5% - 50%
        if (crr < 50000 || crr > 500000) {
            return (false, "CRR must be between 50000 (5%) and 500000 (50%)");
        }

        // Trade fee max: 10%
        if (tradeFee > 1000) {
            return (false, "Trade fee must be <= 1000 (10%)");
        }

        // Protocol fee max: 50%
        if (protocolFee > 5000) {
            return (false, "Protocol fee must be <= 5000 (50%)");
        }

        // IBR duration: 1-30 days
        if (ibrDuration < 1 days || ibrDuration > 30 days) {
            return (false, "IBR duration must be between 1 and 30 days");
        }

        return (true, "");
    }
}
