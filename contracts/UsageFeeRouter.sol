// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./libraries/AccessControlBase.sol";
import "./libraries/ValidationLib.sol";
import "./libraries/FeeLib.sol";
import "./HokusaiAMM.sol";
import "./HokusaiAMMFactory.sol";

/**
 * @title UsageFeeRouter
 * @dev Routes API usage fees to appropriate AMM pools
 *
 * Responsibilities:
 * - Receive API usage fees from backend services
 * - Distribute fees to correct AMM pools
 * - Apply protocol fee split
 * - Support batch deposits for gas efficiency
 * - Emit events for tracking and analytics
 */
contract UsageFeeRouter is AccessControlBase, ReentrancyGuard {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    bytes32 public constant FEE_DEPOSITOR_ROLE = keccak256("FEE_DEPOSITOR_ROLE");

    HokusaiAMMFactory public immutable factory;
    IERC20 public immutable reserveToken; // USDC
    address public treasury; // Protocol treasury

    uint16 public protocolFeeBps; // Protocol fee in basis points (default 500 = 5%)

    // Statistics
    uint256 public totalFeesDeposited;
    uint256 public totalProtocolFees;
    mapping(string => uint256) public modelFees; // modelId => total fees deposited

    // ============================================================
    // CONSTANTS
    // ============================================================

    uint16 public constant MAX_PROTOCOL_FEE = 5000; // 50% max

    // ============================================================
    // EVENTS
    // ============================================================

    event FeeDeposited(
        string indexed modelId,
        address indexed poolAddress,
        uint256 amount,
        uint256 protocolFee,
        uint256 poolDeposit,
        address indexed depositor
    );

    event BatchDeposited(
        uint256 totalAmount,
        uint256 totalProtocolFee,
        uint256 poolCount,
        address indexed depositor
    );

    event ProtocolFeeUpdated(uint16 newProtocolFeeBps);
    event TreasuryUpdated(address indexed newTreasury);
    event ProtocolFeesWithdrawn(address indexed recipient, uint256 amount);

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize router with factory and treasury
     * @param _factory HokusaiAMMFactory address
     * @param _reserveToken Reserve token address (USDC)
     * @param _treasury Treasury address for protocol fees
     * @param _protocolFeeBps Protocol fee in basis points
     */
    constructor(
        address _factory,
        address _reserveToken,
        address _treasury,
        uint16 _protocolFeeBps
    ) AccessControlBase(msg.sender) {
        ValidationLib.requireNonZeroAddress(_factory, "factory");
        ValidationLib.requireNonZeroAddress(_reserveToken, "reserve token");
        ValidationLib.requireNonZeroAddress(_treasury, "treasury");
        FeeLib.requireValidFee(_protocolFeeBps, MAX_PROTOCOL_FEE);

        factory = HokusaiAMMFactory(_factory);
        reserveToken = IERC20(_reserveToken);
        treasury = _treasury;
        protocolFeeBps = _protocolFeeBps;

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
        require(factory.hasPool(modelId), "Pool does not exist");

        address poolAddress = factory.getPool(modelId);
        ValidationLib.requireNonZeroAddress(poolAddress, "pool address");

        // Calculate protocol fee using FeeLib
        (uint256 poolDeposit, uint256 protocolFee) = FeeLib.applyFee(amount, protocolFeeBps);

        // Transfer USDC from depositor to this contract
        require(
            reserveToken.transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );

        // Send protocol fee to treasury
        if (protocolFee > 0) {
            require(
                reserveToken.transfer(treasury, protocolFee),
                "Protocol fee transfer failed"
            );
            totalProtocolFees += protocolFee;
        }

        // Deposit to pool (increases reserve without minting)
        HokusaiAMM pool = HokusaiAMM(poolAddress);
        reserveToken.approve(poolAddress, poolDeposit);
        pool.depositFees(poolDeposit);

        // Update statistics
        totalFeesDeposited += amount;
        modelFees[modelId] += amount;

        emit FeeDeposited(
            modelId,
            poolAddress,
            amount,
            protocolFee,
            poolDeposit,
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
        uint256 totalProtocolFee = 0;

        // Calculate totals and validate
        for (uint256 i = 0; i < modelIds.length; i++) {
            ValidationLib.requirePositiveAmount(amounts[i], "amount");
            require(factory.hasPool(modelIds[i]), "Pool does not exist");
            totalAmount += amounts[i];
        }

        // Transfer total USDC from depositor
        require(
            reserveToken.transferFrom(msg.sender, address(this), totalAmount),
            "Transfer failed"
        );

        // Process each deposit
        for (uint256 i = 0; i < modelIds.length; i++) {
            string memory modelId = modelIds[i];
            uint256 amount = amounts[i];
            address poolAddress = factory.getPool(modelId);

            // Calculate protocol fee using FeeLib
            (uint256 poolDeposit, uint256 protocolFee) = FeeLib.applyFee(amount, protocolFeeBps);

            totalProtocolFee += protocolFee;

            // Deposit to pool
            HokusaiAMM pool = HokusaiAMM(poolAddress);
            reserveToken.approve(poolAddress, poolDeposit);
            pool.depositFees(poolDeposit);

            // Update statistics
            modelFees[modelId] += amount;

            emit FeeDeposited(
                modelId,
                poolAddress,
                amount,
                protocolFee,
                poolDeposit,
                msg.sender
            );
        }

        // Send total protocol fees to treasury
        if (totalProtocolFee > 0) {
            require(
                reserveToken.transfer(treasury, totalProtocolFee),
                "Protocol fee transfer failed"
            );
            totalProtocolFees += totalProtocolFee;
        }

        totalFeesDeposited += totalAmount;

        emit BatchDeposited(
            totalAmount,
            totalProtocolFee,
            modelIds.length,
            msg.sender
        );
    }

    // ============================================================
    // ADMIN FUNCTIONS
    // ============================================================

    /**
     * @dev Update protocol fee percentage
     * @param newProtocolFeeBps New protocol fee in basis points
     */
    function setProtocolFee(uint16 newProtocolFeeBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        FeeLib.requireValidFee(newProtocolFeeBps, MAX_PROTOCOL_FEE);
        protocolFeeBps = newProtocolFeeBps;
        emit ProtocolFeeUpdated(newProtocolFeeBps);
    }

    /**
     * @dev Update treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        ValidationLib.requireNonZeroAddress(newTreasury, "treasury");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /**
     * @dev Withdraw accumulated USDC (emergency only)
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        ValidationLib.requirePositiveAmount(amount, "amount");
        uint256 balance = reserveToken.balanceOf(address(this));
        require(amount <= balance, "Insufficient balance");

        require(
            reserveToken.transfer(treasury, amount),
            "Withdrawal failed"
        );

        emit ProtocolFeesWithdrawn(treasury, amount);
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

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
     * @dev Calculate fee split for a given amount
     * @param amount Total fee amount
     * @return protocolFee Amount going to treasury
     * @return poolDeposit Amount going to pool
     */
    function calculateFeeSplit(uint256 amount)
        external
        view
        returns (uint256 protocolFee, uint256 poolDeposit)
    {
        (poolDeposit, protocolFee) = FeeLib.applyFee(amount, protocolFeeBps);
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
