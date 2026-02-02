// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./libraries/ValidationLib.sol";
import "./libraries/FeeLib.sol";
import "./HokusaiAMM.sol";
import "./ModelRegistry.sol";
import "./TokenManager.sol";

/**
 * @title HokusaiAMMFactory
 * @dev Factory contract for deploying and managing HokusaiAMM pools
 *
 * Responsibilities:
 * - Deploy new AMM pools for Hokusai tokens
 * - Initialize pools with correct parameters
 * - Register pools with ModelRegistry
 * - Authorize AMMs with TokenManager
 * - Track all deployed pools
 */
contract HokusaiAMMFactory is Ownable {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    ModelRegistry public immutable modelRegistry;
    TokenManager public immutable tokenManager;
    address public immutable reserveToken; // USDC

    address public treasury; // Fee recipient
    uint256 public defaultCrr; // Default reserve ratio in ppm
    uint256 public defaultTradeFee; // Default trade fee in bps
    uint256 public defaultIbrDuration; // Default IBR duration in seconds
    uint256 public defaultFlatCurveThreshold; // Default flat curve threshold (6 decimals)
    uint256 public defaultFlatCurvePrice; // Default flat curve price (6 decimals)

    // Pool tracking
    mapping(string => address) public pools; // modelId => pool address
    mapping(address => string) public poolToModel; // pool => modelId
    mapping(address => bool) public isPool; // Quick lookup
    address[] public allPools; // Array of all pools

    // ============================================================
    // CONSTANTS
    // ============================================================

    uint256 public constant MIN_CRR = 50000; // 5%
    uint256 public constant MAX_CRR = 500000; // 50%
    uint256 public constant MAX_TRADE_FEE = 1000; // 10%
    uint256 public constant MIN_IBR_DURATION = 1 days;
    uint256 public constant MAX_IBR_DURATION = 30 days;

    // ============================================================
    // EVENTS
    // ============================================================

    event PoolCreated(
        string indexed modelId,
        address indexed poolAddress,
        address indexed tokenAddress,
        uint256 crr,
        uint256 tradeFee,
        uint256 ibrDuration
    );

    event DefaultsUpdated(
        uint256 newCrr,
        uint256 newTradeFee,
        uint256 newIbrDuration
    );

    event TreasuryUpdated(address indexed newTreasury);

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize factory with core dependencies
     * @param _modelRegistry ModelRegistry contract address
     * @param _tokenManager TokenManager contract address
     * @param _reserveToken Reserve token address (USDC)
     * @param _treasury Treasury address for fees
     */
    constructor(
        address _modelRegistry,
        address _tokenManager,
        address _reserveToken,
        address _treasury
    ) Ownable() {
        ValidationLib.requireNonZeroAddress(_modelRegistry, "registry");
        ValidationLib.requireNonZeroAddress(_tokenManager, "token manager");
        ValidationLib.requireNonZeroAddress(_reserveToken, "reserve token");
        ValidationLib.requireNonZeroAddress(_treasury, "treasury");

        modelRegistry = ModelRegistry(_modelRegistry);
        tokenManager = TokenManager(_tokenManager);
        reserveToken = _reserveToken;
        treasury = _treasury;

        // Set defaults (can be changed by owner)
        defaultCrr = 100000; // 10%
        defaultTradeFee = 30; // 0.30%
        defaultIbrDuration = 7 days;
        defaultFlatCurveThreshold = 25000 * 1e6; // $25,000 USDC
        defaultFlatCurvePrice = 1e4; // $0.01 (6 decimals: 0.01 * 1e6 = 10000)
    }

    // ============================================================
    // POOL CREATION
    // ============================================================

    /**
     * @dev Create a new AMM pool with default parameters
     * @param modelId String model identifier
     * @param tokenAddress Token address for this model
     * @return poolAddress Deployed pool address
     */
    function createPool(
        string memory modelId,
        address tokenAddress
    ) external onlyOwner returns (address poolAddress) {
        return createPoolWithParams(
            modelId,
            tokenAddress,
            defaultCrr,
            defaultTradeFee,
            defaultIbrDuration,
            defaultFlatCurveThreshold,
            defaultFlatCurvePrice
        );
    }

    /**
     * @dev Create a new AMM pool with custom parameters
     * @param modelId String model identifier
     * @param tokenAddress Token address for this model
     * @param crr Reserve ratio in ppm
     * @param tradeFee Trade fee in bps
     * @param ibrDuration IBR duration in seconds
     * @param flatCurveThreshold Reserve amount where bonding curve activates (6 decimals)
     * @param flatCurvePrice Fixed price per token during flat period (6 decimals)
     * @return poolAddress Deployed pool address
     */
    function createPoolWithParams(
        string memory modelId,
        address tokenAddress,
        uint256 crr,
        uint256 tradeFee,
        uint256 ibrDuration,
        uint256 flatCurveThreshold,
        uint256 flatCurvePrice
    ) public onlyOwner returns (address poolAddress) {
        // Validate inputs
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(tokenAddress, "token address");
        require(pools[modelId] == address(0), "Pool already exists");
        ValidationLib.requireInBounds(crr, MIN_CRR, MAX_CRR);
        FeeLib.requireValidFee(tradeFee, MAX_TRADE_FEE);
        ValidationLib.requireInBounds(ibrDuration, MIN_IBR_DURATION, MAX_IBR_DURATION);
        ValidationLib.requirePositiveAmount(flatCurveThreshold, "flat curve threshold");
        ValidationLib.requirePositiveAmount(flatCurvePrice, "flat curve price");

        // Verify token is registered with TokenManager
        require(
            tokenManager.hasToken(modelId),
            "Token not registered with TokenManager"
        );
        require(
            tokenManager.getTokenAddress(modelId) == tokenAddress,
            "Token address mismatch"
        );

        // Deploy new AMM
        HokusaiAMM newPool = new HokusaiAMM(
            reserveToken,
            tokenAddress,
            address(tokenManager),
            modelId,
            treasury,
            crr,
            tradeFee,
            ibrDuration,
            flatCurveThreshold,
            flatCurvePrice
        );
        poolAddress = address(newPool);

        // Track pool
        pools[modelId] = poolAddress;
        poolToModel[poolAddress] = modelId;
        isPool[poolAddress] = true;
        allPools.push(poolAddress);

        emit PoolCreated(
            modelId,
            poolAddress,
            tokenAddress,
            crr,
            tradeFee,
            ibrDuration
        );

        return poolAddress;
    }

    // ============================================================
    // POOL LOOKUP
    // ============================================================

    /**
     * @dev Get pool address for a model
     * @param modelId String model identifier
     * @return Pool address (or zero address if not found)
     */
    function getPool(string memory modelId) external view returns (address) {
        return pools[modelId];
    }

    /**
     * @dev Get model ID for a pool
     * @param poolAddress Pool address
     * @return Model identifier
     */
    function getModelId(address poolAddress) external view returns (string memory) {
        require(isPool[poolAddress], "Not a valid pool");
        return poolToModel[poolAddress];
    }

    /**
     * @dev Check if a pool exists for a model
     * @param modelId String model identifier
     * @return True if pool exists
     */
    function hasPool(string memory modelId) external view returns (bool) {
        return pools[modelId] != address(0);
    }

    /**
     * @dev Get total number of pools
     * @return Number of pools
     */
    function poolCount() external view returns (uint256) {
        return allPools.length;
    }

    /**
     * @dev Get pool at specific index
     * @param index Array index
     * @return Pool address
     */
    function poolAt(uint256 index) external view returns (address) {
        require(index < allPools.length, "Index out of bounds");
        return allPools[index];
    }

    /**
     * @dev Get all pool addresses
     * @return Array of all pool addresses
     */
    function getAllPools() external view returns (address[] memory) {
        return allPools;
    }

    // ============================================================
    // CONFIGURATION
    // ============================================================

    /**
     * @dev Update default parameters for new pools
     * @param newCrr New default reserve ratio
     * @param newTradeFee New default trade fee
     * @param newIbrDuration New default IBR duration
     */
    function setDefaults(
        uint256 newCrr,
        uint256 newTradeFee,
        uint256 newIbrDuration
    ) external onlyOwner {
        ValidationLib.requireInBounds(newCrr, MIN_CRR, MAX_CRR);
        FeeLib.requireValidFee(newTradeFee, MAX_TRADE_FEE);
        ValidationLib.requireInBounds(newIbrDuration, MIN_IBR_DURATION, MAX_IBR_DURATION);

        defaultCrr = newCrr;
        defaultTradeFee = newTradeFee;
        defaultIbrDuration = newIbrDuration;

        emit DefaultsUpdated(newCrr, newTradeFee, newIbrDuration);
    }

    /**
     * @dev Update treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        ValidationLib.requireNonZeroAddress(newTreasury, "treasury");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    /**
     * @dev Get pool information
     * @param modelId String model identifier
     * @return poolAddress Pool address
     * @return tokenAddress Token address
     * @return crr Reserve ratio
     * @return tradeFee Trade fee
     * @return reserveBalance Current reserve balance
     * @return spotPrice Current spot price
     */
    function getPoolInfo(string memory modelId)
        external
        view
        returns (
            address poolAddress,
            address tokenAddress,
            uint256 crr,
            uint256 tradeFee,
            uint256 reserveBalance,
            uint256 spotPrice
        )
    {
        poolAddress = pools[modelId];
        require(poolAddress != address(0), "Pool not found");

        HokusaiAMM pool = HokusaiAMM(poolAddress);
        tokenAddress = pool.hokusaiToken();
        crr = pool.crr();
        tradeFee = pool.tradeFee();
        reserveBalance = pool.reserveBalance();
        spotPrice = pool.spotPrice();
    }
}
