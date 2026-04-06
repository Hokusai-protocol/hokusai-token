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
    // RECONCILIATION STATE
    // ============================================================

    /// @dev Estimated costs snapshot per model per period
    mapping(string => mapping(uint256 => uint256)) public estimatedCosts;

    /// @dev Actual costs paid per model per period
    mapping(string => mapping(uint256 => uint256)) public actualCosts;

    /// @dev Current active period index per model
    mapping(string => uint256) public currentPeriod;

    /// @dev Reconciliation period length in seconds (aligned with price epoch)
    uint256 public reconciliationPeriod;

    /// @dev Period start timestamps per model
    mapping(string => mapping(uint256 => uint256)) public periodStartTime;

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

    /// @dev Variance record for historical tracking
    struct VarianceRecord {
        uint256 period;
        uint256 estimated;
        uint256 actual;
        int256 varianceBps;
        uint256 timestamp;
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

    event EstimatedCostsSnapshot(
        string indexed modelId,
        uint256 indexed period,
        uint256 estimatedCost,
        uint256 timestamp
    );

    event ActualCostsRecorded(
        string indexed modelId,
        uint256 indexed period,
        uint256 amount,
        bytes32 indexed invoiceHash,
        uint256 newTotal
    );

    event CostReconciled(
        string indexed modelId,
        uint256 indexed period,
        uint256 estimated,
        uint256 actual,
        int256 varianceBps
    );

    event AdjustmentSuggested(
        string indexed modelId,
        uint256 currentEstimate,
        uint256 suggestedEstimate,
        int256 varianceBps
    );

    event ReconciliationPeriodUpdated(
        uint256 oldPeriod,
        uint256 newPeriod
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

        // Set default reconciliation period to 30 days
        reconciliationPeriod = 30 days;

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

        // Record actual costs for reconciliation
        _recordActualCostsInternal(modelId, amount, invoiceHash);

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

            // Record actual costs for reconciliation
            _recordActualCostsInternal(p.modelId, p.amount, p.invoiceHash);

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

    /**
     * @dev Update reconciliation period length
     * @param newPeriod New period length in seconds
     */
    function setReconciliationPeriod(uint256 newPeriod)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(newPeriod > 0, "Period must be positive");
        uint256 oldPeriod = reconciliationPeriod;
        reconciliationPeriod = newPeriod;
        emit ReconciliationPeriodUpdated(oldPeriod, newPeriod);
    }

    // ============================================================
    // RECONCILIATION FUNCTIONS
    // ============================================================

    /**
     * @dev Snapshot estimated costs for current period from oracle
     * @param modelId String model identifier
     * @param estimatedCost Estimated cost from oracle for this period
     */
    function snapshotEstimatedCosts(string memory modelId, uint256 estimatedCost)
        external
        onlyRole(PAYER_ROLE)
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requirePositiveAmount(estimatedCost, "estimated cost");

        uint256 period = currentPeriod[modelId];

        // Initialize period start time if not set
        if (periodStartTime[modelId][period] == 0) {
            periodStartTime[modelId][period] = block.timestamp;
        }

        estimatedCosts[modelId][period] = estimatedCost;

        emit EstimatedCostsSnapshot(modelId, period, estimatedCost, block.timestamp);
    }

    /**
     * @dev Record actual infrastructure costs for current period
     * @param modelId String model identifier
     * @param period Period index to record costs for
     * @param actualCost Actual cost paid
     * @param invoiceHash Hash of invoice for audit trail
     */
    function recordActualCosts(
        string memory modelId,
        uint256 period,
        uint256 actualCost,
        bytes32 invoiceHash
    ) external onlyRole(PAYER_ROLE) {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requirePositiveAmount(actualCost, "actual cost");

        actualCosts[modelId][period] += actualCost;

        emit ActualCostsRecorded(
            modelId,
            period,
            actualCost,
            invoiceHash,
            actualCosts[modelId][period]
        );
    }

    /**
     * @dev Advance to next reconciliation period for a model
     * @param modelId String model identifier
     */
    function advancePeriod(string memory modelId)
        external
        onlyRole(PAYER_ROLE)
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        uint256 period = currentPeriod[modelId];
        uint256 startTime = periodStartTime[modelId][period];

        require(startTime > 0, "Period not initialized");
        require(
            block.timestamp >= startTime + reconciliationPeriod,
            "Period not elapsed"
        );

        // Reconcile current period before advancing
        uint256 estimated = estimatedCosts[modelId][period];
        uint256 actual = actualCosts[modelId][period];

        if (estimated > 0 && actual > 0) {
            int256 varianceBps = _calculateVarianceBps(estimated, actual);
            emit CostReconciled(modelId, period, estimated, actual, varianceBps);
        }

        // Advance to next period
        currentPeriod[modelId] = period + 1;
        periodStartTime[modelId][period + 1] = block.timestamp;
    }

    /**
     * @dev Get variance for a specific period
     * @param modelId String model identifier
     * @param period Period index
     * @return estimated Estimated cost for period
     * @return actual Actual cost for period
     * @return varianceBps Variance in basis points (positive = underestimated)
     */
    function getVariance(string memory modelId, uint256 period)
        external
        view
        returns (
            uint256 estimated,
            uint256 actual,
            int256 varianceBps
        )
    {
        estimated = estimatedCosts[modelId][period];
        actual = actualCosts[modelId][period];

        if (estimated > 0 && actual > 0) {
            varianceBps = _calculateVarianceBps(estimated, actual);
        } else {
            varianceBps = 0;
        }
    }

    /**
     * @dev Get variance history for multiple periods
     * @param modelId String model identifier
     * @param periods Number of recent periods to retrieve
     * @return records Array of variance records
     */
    function getVarianceHistory(string memory modelId, uint256 periods)
        external
        view
        returns (VarianceRecord[] memory records)
    {
        uint256 currentPeriodIndex = currentPeriod[modelId];
        // Available periods are [0, currentPeriodIndex], so currentPeriodIndex + 1 total periods
        uint256 availablePeriods = currentPeriodIndex + 1;
        uint256 recordCount = periods > availablePeriods ? availablePeriods : periods;

        records = new VarianceRecord[](recordCount);

        // Start from the oldest period we want to include
        uint256 startPeriod = currentPeriodIndex + 1 >= recordCount
            ? currentPeriodIndex + 1 - recordCount
            : 0;

        for (uint256 i = 0; i < recordCount; i++) {
            uint256 periodIndex = startPeriod + i;
            uint256 estimated = estimatedCosts[modelId][periodIndex];
            uint256 actual = actualCosts[modelId][periodIndex];

            records[i] = VarianceRecord({
                period: periodIndex,
                estimated: estimated,
                actual: actual,
                varianceBps: (estimated > 0 && actual > 0) ? _calculateVarianceBps(estimated, actual) : int256(0),
                timestamp: periodStartTime[modelId][periodIndex]
            });
        }
    }

    /**
     * @dev Suggest cost adjustment based on recent variance
     * @param modelId String model identifier
     * @return adjustmentBps Adjustment in basis points
     * @return suggestedCost Suggested cost for next period
     */
    function suggestCostAdjustment(string memory modelId)
        external
        returns (int256 adjustmentBps, uint256 suggestedCost)
    {
        uint256 currentPeriodIndex = currentPeriod[modelId];
        require(currentPeriodIndex >= 3, "Need at least 3 periods");

        // Get last 3 periods variance
        int256 totalWeightedVariance = 0;
        uint256 totalWeight = 0;

        // Weighted average: most recent period has highest weight
        uint256[3] memory weights = [uint256(1), 2, 3]; // oldest to newest

        for (uint256 i = 0; i < 3; i++) {
            uint256 periodIndex = currentPeriodIndex - 3 + i;
            uint256 estimated = estimatedCosts[modelId][periodIndex];
            uint256 actual = actualCosts[modelId][periodIndex];

            if (estimated > 0 && actual > 0) {
                int256 varianceBps = _calculateVarianceBps(estimated, actual);
                totalWeightedVariance += varianceBps * int256(weights[i]);
                totalWeight += weights[i];
            }
        }

        require(totalWeight > 0, "No valid variance data");

        // Calculate weighted average variance
        int256 avgVarianceBps = totalWeightedVariance / int256(totalWeight);

        // Get current estimate (most recent period's estimate)
        uint256 currentEstimate = estimatedCosts[modelId][currentPeriodIndex - 1];
        require(currentEstimate > 0, "No current estimate");

        // Check if variance exceeds tolerance (5% = 500 bps)
        int256 absVariance = avgVarianceBps >= 0 ? avgVarianceBps : -avgVarianceBps;

        if (absVariance > 500) {
            // Apply adjustment
            if (avgVarianceBps <= -10000) {
                adjustmentBps = -10000;
                suggestedCost = 0;
            } else {
                adjustmentBps = avgVarianceBps;
                // suggestedCost = currentEstimate * (10000 + avgVarianceBps) / 10000
                int256 adjustedCost = int256(currentEstimate) * (10000 + avgVarianceBps) / 10000;
                suggestedCost = uint256(adjustedCost);
            }
        } else {
            // Within tolerance, no adjustment
            adjustmentBps = 0;
            suggestedCost = currentEstimate;
        }

        emit AdjustmentSuggested(modelId, currentEstimate, suggestedCost, avgVarianceBps);
    }

    // ============================================================
    // INTERNAL FUNCTIONS
    // ============================================================

    /**
     * @dev Internal function to record actual costs
     * @param modelId String model identifier
     * @param amount Amount paid
     * @param invoiceHash Invoice hash for audit trail
     */
    function _recordActualCostsInternal(
        string memory modelId,
        uint256 amount,
        bytes32 invoiceHash
    ) internal {
        uint256 period = currentPeriod[modelId];

        // Initialize period start time if not set
        if (periodStartTime[modelId][period] == 0) {
            periodStartTime[modelId][period] = block.timestamp;
        }

        actualCosts[modelId][period] += amount;

        emit ActualCostsRecorded(
            modelId,
            period,
            amount,
            invoiceHash,
            actualCosts[modelId][period]
        );
    }

    /**
     * @dev Calculate variance in basis points
     * @param estimated Estimated cost
     * @param actual Actual cost
     * @return Variance in bps (positive = underestimated, negative = overestimated)
     */
    function _calculateVarianceBps(uint256 estimated, uint256 actual)
        internal
        pure
        returns (int256)
    {
        // variance = ((actual - estimated) / estimated) * 10000
        int256 difference = int256(actual) - int256(estimated);
        int256 varianceBps = (difference * 10000) / int256(estimated);
        return varianceBps;
    }
}
