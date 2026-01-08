// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
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
    uint16 public defaultProtocolFeeBps; // Default protocol fee in bps
    uint256 public defaultIbrDuration; // Default IBR duration in seconds

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
    uint256 public constant MAX_PROTOCOL_FEE = 5000; // 50%
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
        uint16 protocolFeeBps,
        uint256 ibrDuration
    );

    event DefaultsUpdated(
        uint256 newCrr,
        uint256 newTradeFee,
        uint16 newProtocolFeeBps,
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
        require(_modelRegistry != address(0), "Invalid registry");
        require(_tokenManager != address(0), "Invalid token manager");
        require(_reserveToken != address(0), "Invalid reserve token");
        require(_treasury != address(0), "Invalid treasury");

        modelRegistry = ModelRegistry(_modelRegistry);
        tokenManager = TokenManager(_tokenManager);
        reserveToken = _reserveToken;
        treasury = _treasury;

        // Set defaults (can be changed by owner)
        defaultCrr = 100000; // 10%
        defaultTradeFee = 25; // 0.25%
        defaultProtocolFeeBps = 500; // 5%
        defaultIbrDuration = 7 days;
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
            defaultProtocolFeeBps,
            defaultIbrDuration
        );
    }

    /**
     * @dev Create a new AMM pool with custom parameters
     * @param modelId String model identifier
     * @param tokenAddress Token address for this model
     * @param crr Reserve ratio in ppm
     * @param tradeFee Trade fee in bps
     * @param protocolFeeBps Protocol fee in bps
     * @param ibrDuration IBR duration in seconds
     * @return poolAddress Deployed pool address
     */
    function createPoolWithParams(
        string memory modelId,
        address tokenAddress,
        uint256 crr,
        uint256 tradeFee,
        uint16 protocolFeeBps,
        uint256 ibrDuration
    ) public onlyOwner returns (address poolAddress) {
        // Validate inputs
        require(bytes(modelId).length > 0, "Empty model ID");
        require(tokenAddress != address(0), "Invalid token address");
        require(pools[modelId] == address(0), "Pool already exists");
        require(crr >= MIN_CRR && crr <= MAX_CRR, "CRR out of bounds");
        require(tradeFee <= MAX_TRADE_FEE, "Trade fee too high");
        require(protocolFeeBps <= MAX_PROTOCOL_FEE, "Protocol fee too high");
        require(
            ibrDuration >= MIN_IBR_DURATION && ibrDuration <= MAX_IBR_DURATION,
            "IBR duration out of bounds"
        );

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
            protocolFeeBps,
            ibrDuration
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
            protocolFeeBps,
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
     * @param newProtocolFeeBps New default protocol fee
     * @param newIbrDuration New default IBR duration
     */
    function setDefaults(
        uint256 newCrr,
        uint256 newTradeFee,
        uint16 newProtocolFeeBps,
        uint256 newIbrDuration
    ) external onlyOwner {
        require(newCrr >= MIN_CRR && newCrr <= MAX_CRR, "CRR out of bounds");
        require(newTradeFee <= MAX_TRADE_FEE, "Trade fee too high");
        require(newProtocolFeeBps <= MAX_PROTOCOL_FEE, "Protocol fee too high");
        require(
            newIbrDuration >= MIN_IBR_DURATION && newIbrDuration <= MAX_IBR_DURATION,
            "IBR duration out of bounds"
        );

        defaultCrr = newCrr;
        defaultTradeFee = newTradeFee;
        defaultProtocolFeeBps = newProtocolFeeBps;
        defaultIbrDuration = newIbrDuration;

        emit DefaultsUpdated(newCrr, newTradeFee, newProtocolFeeBps, newIbrDuration);
    }

    /**
     * @dev Update treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");
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
