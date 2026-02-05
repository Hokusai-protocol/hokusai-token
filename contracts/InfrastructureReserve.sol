// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./HokusaiAMMFactory.sol";
import "./libraries/ValidationLib.sol";

/**
 * @title InfrastructureReserve
 * @dev Manages infrastructure cost accrual and payments for Hokusai model tokens
 *
 * This contract:
 * - Receives infrastructure cost accruals from UsageFeeRouter
 * - Tracks per-model infrastructure reserve balances
 * - Enables manual payments to infrastructure providers (Phase 1)
 * - Provides transparency via on-chain events and accounting
 * - Supports emergency pause and withdrawal mechanisms
 */
contract InfrastructureReserve is AccessControl, ReentrancyGuard, Pausable {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    /// @dev Reserve token (USDC)
    IERC20 public immutable reserveToken;

    /// @dev Factory contract for pool validation
    HokusaiAMMFactory public immutable factory;

    /// @dev Treasury address for emergency withdrawals
    address public treasury;

    // ============================================================
    // PER-MODEL ACCOUNTING
    // ============================================================

    /// @dev Total accrued for infrastructure per model (net after payments)
    mapping(string => uint256) public accrued;

    /// @dev Total paid to providers per model (cumulative)
    mapping(string => uint256) public paid;

    /// @dev Current infrastructure provider per model
    mapping(string => address) public provider;

    // ============================================================
    // GLOBAL STATISTICS
    // ============================================================

    /// @dev Total accrued across all models (cumulative)
    uint256 public totalAccrued;

    /// @dev Total paid across all models (cumulative)
    uint256 public totalPaid;

    // ============================================================
    // ROLES
    // ============================================================

    /// @dev Role for depositing infrastructure fees (UsageFeeRouter)
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    /// @dev Role for paying infrastructure costs (Treasury multisig)
    bytes32 public constant PAYER_ROLE = keccak256("PAYER_ROLE");

    // ============================================================
    // STRUCTS
    // ============================================================

    /// @dev Payment structure for batch operations
    struct Payment {
        string modelId;
        address payee;
        uint256 amount;
        bytes32 invoiceHash;
        string memo;
    }

    // ============================================================
    // EVENTS
    // ============================================================

    event InfrastructureDeposited(
        string indexed modelId,
        uint256 amount,
        uint256 newBalance
    );

    event InfrastructureCostPaid(
        string indexed modelId,
        address indexed payee,
        uint256 amount,
        bytes32 indexed invoiceHash,
        string memo,
        address payer
    );

    event BatchDeposited(
        uint256 modelCount,
        uint256 totalAmount
    );

    event BatchPaymentCompleted(
        uint256 paymentCount,
        uint256 totalAmount
    );

    event ProviderSet(
        string indexed modelId,
        address indexed provider
    );

    event TreasuryUpdated(
        address indexed oldTreasury,
        address indexed newTreasury
    );

    event EmergencyWithdrawal(
        address indexed recipient,
        uint256 amount
    );

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize the infrastructure reserve
     * @param _reserveToken USDC token address
     * @param _factory HokusaiAMMFactory address for pool validation
     * @param _treasury Treasury address for emergency withdrawals
     */
    constructor(
        address _reserveToken,
        address _factory,
        address _treasury
    ) {
        ValidationLib.requireNonZeroAddress(_reserveToken, "reserve token");
        ValidationLib.requireNonZeroAddress(_factory, "factory");
        ValidationLib.requireNonZeroAddress(_treasury, "treasury");

        reserveToken = IERC20(_reserveToken);
        factory = HokusaiAMMFactory(_factory);
        treasury = _treasury;

        // Grant DEFAULT_ADMIN_ROLE to deployer
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ============================================================
    // DEPOSIT FUNCTIONS
    // ============================================================

    /**
     * @dev Deposit infrastructure accrual for a single model
     * @param modelId String model identifier
     * @param amount Amount of USDC to deposit
     */
    function deposit(string memory modelId, uint256 amount)
        external
        onlyRole(DEPOSITOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        ValidationLib.requirePositiveAmount(amount, "amount");
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        require(factory.hasPool(modelId), "Model pool does not exist");

        // Transfer USDC from depositor
        require(
            reserveToken.transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );

        // Update accounting
        accrued[modelId] += amount;
        totalAccrued += amount;

        emit InfrastructureDeposited(modelId, amount, accrued[modelId]);
    }

    /**
     * @dev Deposit infrastructure accrual for multiple models (batch operation)
     * @param modelIds Array of model identifiers
     * @param amounts Array of amounts corresponding to each model
     */
    function batchDeposit(
        string[] memory modelIds,
        uint256[] memory amounts
    ) external onlyRole(DEPOSITOR_ROLE) nonReentrant whenNotPaused {
        ValidationLib.requireMatchingArrayLengths(modelIds.length, amounts.length);
        ValidationLib.requireNonEmptyArray(modelIds.length);

        uint256 totalAmount = 0;

        // Validate and accumulate total
        for (uint256 i = 0; i < modelIds.length; i++) {
            ValidationLib.requirePositiveAmount(amounts[i], "amount");
            ValidationLib.requireNonEmptyString(modelIds[i], "model ID");
            require(factory.hasPool(modelIds[i]), "Model pool does not exist");

            // Update per-model accounting
            accrued[modelIds[i]] += amounts[i];
            totalAmount += amounts[i];

            emit InfrastructureDeposited(modelIds[i], amounts[i], accrued[modelIds[i]]);
        }

        // Single USDC transfer for gas efficiency
        require(
            reserveToken.transferFrom(msg.sender, address(this), totalAmount),
            "Transfer failed"
        );

        // Update global statistics
        totalAccrued += totalAmount;

        emit BatchDeposited(modelIds.length, totalAmount);
    }

    // ============================================================
    // PAYMENT FUNCTIONS
    // ============================================================

    /**
     * @dev Pay infrastructure cost for a single model (manual, Phase 1)
     * @param modelId String model identifier
     * @param payee Address to receive payment
     * @param amount Amount of USDC to pay
     * @param invoiceHash Hash of invoice for transparency
     * @param memo Description or invoice reference
     */
    function payInfrastructureCost(
        string memory modelId,
        address payee,
        uint256 amount,
        bytes32 invoiceHash,
        string memory memo
    ) external onlyRole(PAYER_ROLE) nonReentrant whenNotPaused {
        ValidationLib.requirePositiveAmount(amount, "amount");
        ValidationLib.requireNonZeroAddress(payee, "payee");
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        require(amount <= accrued[modelId], "Exceeds accrued balance");

        // Update accounting BEFORE transfer (CEI pattern)
        accrued[modelId] -= amount;
        paid[modelId] += amount;
        totalPaid += amount;

        // Transfer USDC to provider
        require(
            reserveToken.transfer(payee, amount),
            "Payment failed"
        );

        emit InfrastructureCostPaid(
            modelId,
            payee,
            amount,
            invoiceHash,
            memo,
            msg.sender
        );
    }

    /**
     * @dev Pay infrastructure costs for multiple invoices (batch operation)
     * @param payments Array of Payment structs
     */
    function batchPayInfrastructureCosts(Payment[] memory payments)
        external
        onlyRole(PAYER_ROLE)
        nonReentrant
        whenNotPaused
    {
        ValidationLib.requireNonEmptyArray(payments.length);

        uint256 totalPaidAmount = 0;

        for (uint256 i = 0; i < payments.length; i++) {
            Payment memory p = payments[i];

            ValidationLib.requirePositiveAmount(p.amount, "amount");
            ValidationLib.requireNonZeroAddress(p.payee, "payee");
            ValidationLib.requireNonEmptyString(p.modelId, "model ID");
            require(p.amount <= accrued[p.modelId], "Exceeds accrued balance");

            // Update accounting BEFORE transfer (CEI pattern)
            accrued[p.modelId] -= p.amount;
            paid[p.modelId] += p.amount;
            totalPaidAmount += p.amount;

            // Transfer USDC to provider
            require(
                reserveToken.transfer(p.payee, p.amount),
                "Payment failed"
            );

            emit InfrastructureCostPaid(
                p.modelId,
                p.payee,
                p.amount,
                p.invoiceHash,
                p.memo,
                msg.sender
            );
        }

        // Update global statistics
        totalPaid += totalPaidAmount;

        emit BatchPaymentCompleted(payments.length, totalPaidAmount);
    }

    // ============================================================
    // PROVIDER MANAGEMENT
    // ============================================================

    /**
     * @dev Set infrastructure provider for a model
     * @param modelId String model identifier
     * @param _provider Provider address
     */
    function setProvider(string memory modelId, address _provider)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        ValidationLib.requireNonZeroAddress(_provider, "provider");
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        provider[modelId] = _provider;
        emit ProviderSet(modelId, _provider);
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    /**
     * @dev Calculate accrual runway (days of coverage at given burn rate)
     * @param modelId String model identifier
     * @param dailyBurnRate Daily infrastructure cost in USDC
     * @return daysOfRunway Number of days of coverage remaining
     */
    function getAccrualRunway(string memory modelId, uint256 dailyBurnRate)
        external
        view
        returns (uint256 daysOfRunway)
    {
        if (dailyBurnRate == 0) return type(uint256).max;
        uint256 currentBalance = accrued[modelId];
        daysOfRunway = currentBalance / dailyBurnRate;
    }

    /**
     * @dev Get net accrual balance for a model
     * @param modelId String model identifier
     * @return Net accrual balance (already accounts for payments)
     */
    function getNetAccrual(string memory modelId)
        external
        view
        returns (uint256)
    {
        return accrued[modelId];
    }

    /**
     * @dev Get total payments made for a model
     * @param modelId String model identifier
     * @return Total paid to providers
     */
    function getProviderPayments(string memory modelId)
        external
        view
        returns (uint256)
    {
        return paid[modelId];
    }

    /**
     * @dev Get comprehensive accounting for a model
     * @param modelId String model identifier
     * @return accruedAmount Current accrued balance
     * @return paidAmount Total paid to providers
     * @return currentProvider Current provider address
     */
    function getModelAccounting(string memory modelId)
        external
        view
        returns (
            uint256 accruedAmount,
            uint256 paidAmount,
            address currentProvider
        )
    {
        return (accrued[modelId], paid[modelId], provider[modelId]);
    }

    /**
     * @dev Get contract's USDC balance
     * @return Current USDC balance
     */
    function getBalance() external view returns (uint256) {
        return reserveToken.balanceOf(address(this));
    }

    // ============================================================
    // ADMIN FUNCTIONS
    // ============================================================

    /**
     * @dev Update treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        ValidationLib.requireNonZeroAddress(newTreasury, "treasury");
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @dev Pause deposits and payments (emergency only)
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @dev Unpause deposits and payments
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @dev Emergency withdraw USDC to treasury
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
            "Withdraw failed"
        );

        emit EmergencyWithdrawal(treasury, amount);
    }
}
