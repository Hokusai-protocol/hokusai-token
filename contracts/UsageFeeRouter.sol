// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./libraries/AccessControlBase.sol";
import "./libraries/ValidationLib.sol";
import "./HokusaiAMM.sol";
import "./HokusaiAMMFactory.sol";
import "./InfrastructureReserve.sol";
import "./TokenManager.sol";
import "./interfaces/IHokusaiParams.sol";

/**
 * @title UsageFeeRouter
 * @dev Routes API usage fees to infrastructure reserve and AMM pools
 *
 * Responsibilities:
 * - Receive API usage fees from backend services
 * - Read per-model infrastructure accrual rates from HokusaiParams
 * - Split fees: infrastructure accrual → InfrastructureReserve, profit → AMM
 * - Support batch deposits for gas efficiency
 * - Emit events for tracking and analytics
 *
 * Key Design: Infrastructure is an obligation (paid first), profit is residual
 */
contract UsageFeeRouter is AccessControlBase, ReentrancyGuard {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    bytes32 public constant FEE_DEPOSITOR_ROLE = keccak256("FEE_DEPOSITOR_ROLE");

    HokusaiAMMFactory public immutable factory;
    IERC20 public immutable reserveToken; // USDC
    InfrastructureReserve public immutable infraReserve;

    // Statistics
    uint256 public totalFeesDeposited;
    mapping(string => uint256) public modelFees; // modelId => total fees deposited

    // ============================================================
    // EVENTS
    // ============================================================

    event FeeDeposited(
        string indexed modelId,
        address indexed poolAddress,
        uint256 totalAmount,
        uint256 infrastructureAmount,
        uint256 profitAmount,
        address indexed depositor
    );

    event BatchDeposited(
        uint256 totalAmount,
        uint256 totalInfrastructure,
        uint256 totalProfit,
        uint256 modelCount,
        address indexed depositor
    );

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize router with factory and infrastructure reserve
     * @param _factory HokusaiAMMFactory address
     * @param _reserveToken Reserve token address (USDC)
     * @param _infraReserve InfrastructureReserve address
     */
    constructor(
        address _factory,
        address _reserveToken,
        address _infraReserve
    ) AccessControlBase(msg.sender) {
        ValidationLib.requireNonZeroAddress(_factory, "factory");
        ValidationLib.requireNonZeroAddress(_reserveToken, "reserve token");
        ValidationLib.requireNonZeroAddress(_infraReserve, "infrastructure reserve");

        factory = HokusaiAMMFactory(_factory);
        reserveToken = IERC20(_reserveToken);
        infraReserve = InfrastructureReserve(_infraReserve);

        _grantRole(FEE_DEPOSITOR_ROLE, msg.sender);
    }

    // ============================================================
    // FEE DEPOSIT FUNCTIONS
    // ============================================================

    /**
     * @dev Deposit API usage fee for a single model
     * @param modelId String model identifier
     * @param amount Amount of USDC to deposit
     */
    function depositFee(string memory modelId, uint256 amount)
        external
        nonReentrant
        onlyRole(FEE_DEPOSITOR_ROLE)
    {
        ValidationLib.requirePositiveAmount(amount, "amount");
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        require(factory.hasPool(modelId), "Pool does not exist");

        address poolAddress = factory.getPool(modelId);
        ValidationLib.requireNonZeroAddress(poolAddress, "pool address");

        // Get HokusaiAMM and TokenManager
        HokusaiAMM pool = HokusaiAMM(poolAddress);
        TokenManager tokenManager = pool.tokenManager();

        // Get HokusaiParams address for this model
        address paramsAddress = tokenManager.getParamsAddress(modelId);
        require(paramsAddress != address(0), "Params not found");

        // Read infrastructure accrual rate from params
        IHokusaiParams params = IHokusaiParams(paramsAddress);
        uint16 infraBps = params.infrastructureAccrualBps();

        // Calculate split: infrastructure first, profit is residual
        uint256 infrastructureAmount = (amount * infraBps) / 10000;
        uint256 profitAmount = amount - infrastructureAmount;

        // Transfer total USDC from depositor to this contract
        require(
            reserveToken.transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );

        // Route to infrastructure reserve
        if (infrastructureAmount > 0) {
            reserveToken.approve(address(infraReserve), infrastructureAmount);
            infraReserve.deposit(modelId, infrastructureAmount);
        }

        // Route profit to AMM (increases reserve, benefits token holders)
        if (profitAmount > 0) {
            reserveToken.approve(poolAddress, profitAmount);
            pool.depositFees(profitAmount);
        }

        // Update statistics
        totalFeesDeposited += amount;
        modelFees[modelId] += amount;

        emit FeeDeposited(
            modelId,
            poolAddress,
            amount,
            infrastructureAmount,
            profitAmount,
            msg.sender
        );
    }

    /**
     * @dev Deposit fees for multiple models in a single transaction
     * @param modelIds Array of model identifiers
     * @param amounts Array of amounts (must match modelIds length)
     */
    function batchDepositFees(
        string[] memory modelIds,
        uint256[] memory amounts
    ) external nonReentrant onlyRole(FEE_DEPOSITOR_ROLE) {
        ValidationLib.requireMatchingArrayLengths(modelIds.length, amounts.length);
        ValidationLib.requireNonEmptyArray(modelIds.length);

        uint256 totalAmount = 0;
        uint256 totalInfra = 0;
        uint256 totalProfit = 0;

        // Pre-calculate totals for single USDC transfer
        for (uint256 i = 0; i < modelIds.length; i++) {
            ValidationLib.requirePositiveAmount(amounts[i], "amount");
            ValidationLib.requireNonEmptyString(modelIds[i], "model ID");
            require(factory.hasPool(modelIds[i]), "Pool does not exist");
            totalAmount += amounts[i];
        }

        // Single transfer from depositor
        require(
            reserveToken.transferFrom(msg.sender, address(this), totalAmount),
            "Transfer failed"
        );

        // Process each model
        string[] memory infraModelIds = new string[](modelIds.length);
        uint256[] memory infraAmounts = new uint256[](modelIds.length);

        for (uint256 i = 0; i < modelIds.length; i++) {
            string memory modelId = modelIds[i];
            uint256 amount = amounts[i];

            address poolAddress = factory.getPool(modelId);
            HokusaiAMM pool = HokusaiAMM(poolAddress);

            // Get infrastructure accrual rate from params
            TokenManager tokenManager = pool.tokenManager();
            address paramsAddress = tokenManager.getParamsAddress(modelId);
            require(paramsAddress != address(0), "Params not found");

            IHokusaiParams params = IHokusaiParams(paramsAddress);
            uint16 infraBps = params.infrastructureAccrualBps();

            // Calculate split
            uint256 infrastructureAmount = (amount * infraBps) / 10000;
            uint256 profitAmount = amount - infrastructureAmount;

            // Accumulate for batch operations
            infraModelIds[i] = modelId;
            infraAmounts[i] = infrastructureAmount;
            totalInfra += infrastructureAmount;
            totalProfit += profitAmount;

            // Deposit profit to AMM immediately (can't batch this)
            if (profitAmount > 0) {
                reserveToken.approve(poolAddress, profitAmount);
                pool.depositFees(profitAmount);
            }

            // Update statistics
            modelFees[modelId] += amount;

            emit FeeDeposited(
                modelId,
                poolAddress,
                amount,
                infrastructureAmount,
                profitAmount,
                msg.sender
            );
        }

        // Batch deposit to infrastructure reserve
        if (totalInfra > 0) {
            reserveToken.approve(address(infraReserve), totalInfra);
            infraReserve.batchDeposit(infraModelIds, infraAmounts);
        }

        totalFeesDeposited += totalAmount;

        emit BatchDeposited(
            totalAmount,
            totalInfra,
            totalProfit,
            modelIds.length,
            msg.sender
        );
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    /**
     * @dev Calculate fee split for a given model and amount
     * @param modelId String model identifier
     * @param amount Total fee amount
     * @return infrastructureAmount Amount going to infrastructure reserve
     * @return profitAmount Amount going to AMM profit
     */
    function calculateFeeSplit(string memory modelId, uint256 amount)
        external
        view
        returns (uint256 infrastructureAmount, uint256 profitAmount)
    {
        address poolAddress = factory.getPool(modelId);
        require(poolAddress != address(0), "Pool not found");

        HokusaiAMM pool = HokusaiAMM(poolAddress);
        TokenManager tokenManager = pool.tokenManager();
        address paramsAddress = tokenManager.getParamsAddress(modelId);
        require(paramsAddress != address(0), "Params not found");

        IHokusaiParams params = IHokusaiParams(paramsAddress);
        uint16 infraBps = params.infrastructureAccrualBps();

        infrastructureAmount = (amount * infraBps) / 10000;
        profitAmount = amount - infrastructureAmount;
    }

    /**
     * @dev Get comprehensive stats for a model
     * @param modelId String model identifier
     * @return totalFees Total fees deposited for this model
     * @return currentInfraBps Current infrastructure accrual rate
     * @return currentProfitBps Current profit share rate
     */
    function getModelStats(string memory modelId)
        external
        view
        returns (
            uint256 totalFees,
            uint256 currentInfraBps,
            uint256 currentProfitBps
        )
    {
        totalFees = modelFees[modelId];

        address poolAddress = factory.getPool(modelId);
        if (poolAddress != address(0)) {
            HokusaiAMM pool = HokusaiAMM(poolAddress);
            TokenManager tokenManager = pool.tokenManager();
            address paramsAddress = tokenManager.getParamsAddress(modelId);

            if (paramsAddress != address(0)) {
                IHokusaiParams params = IHokusaiParams(paramsAddress);
                currentInfraBps = params.infrastructureAccrualBps();
                currentProfitBps = 10000 - currentInfraBps;
            }
        }
    }

    /**
     * @dev Get total fees deposited for a model
     * @param modelId String model identifier
     * @return Total fees deposited
     */
    function getModelFees(string memory modelId)
        external
        view
        returns (uint256)
    {
        return modelFees[modelId];
    }

    /**
     * @dev Get current USDC balance in contract
     * @return Current balance
     */
    function getBalance() external view returns (uint256) {
        return reserveToken.balanceOf(address(this));
    }

    /**
     * @dev Check if an address has depositor role
     * @param account Address to check
     * @return True if account has depositor role
     */
    function isDepositor(address account) external view returns (bool) {
        return hasRole(FEE_DEPOSITOR_ROLE, account);
    }
}
