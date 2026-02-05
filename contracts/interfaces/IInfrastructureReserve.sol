// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IInfrastructureReserve
 * @dev Interface for infrastructure cost accrual and payment management
 */
interface IInfrastructureReserve {
    /**
     * @dev Payment structure for batch operations
     */
    struct Payment {
        string modelId;
        address payee;
        uint256 amount;
        bytes32 invoiceHash;
        string memo;
    }

    // ============================================================
    // DEPOSIT FUNCTIONS
    // ============================================================

    /**
     * @dev Deposit infrastructure accrual for a single model
     * @param modelId String model identifier
     * @param amount Amount of USDC to deposit
     */
    function deposit(string memory modelId, uint256 amount) external;

    /**
     * @dev Deposit infrastructure accrual for multiple models
     * @param modelIds Array of model identifiers
     * @param amounts Array of amounts corresponding to each model
     */
    function batchDeposit(
        string[] memory modelIds,
        uint256[] memory amounts
    ) external;

    // ============================================================
    // PAYMENT FUNCTIONS
    // ============================================================

    /**
     * @dev Pay infrastructure cost for a single model
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
    ) external;

    /**
     * @dev Pay infrastructure costs for multiple invoices
     * @param payments Array of Payment structs
     */
    function batchPayInfrastructureCosts(Payment[] memory payments) external;

    // ============================================================
    // PROVIDER MANAGEMENT
    // ============================================================

    /**
     * @dev Set infrastructure provider for a model
     * @param modelId String model identifier
     * @param _provider Provider address
     */
    function setProvider(string memory modelId, address _provider) external;

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
        returns (uint256 daysOfRunway);

    /**
     * @dev Get net accrual balance for a model
     * @param modelId String model identifier
     * @return Net accrual balance
     */
    function getNetAccrual(string memory modelId) external view returns (uint256);

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
        );

    // ============================================================
    // ADMIN FUNCTIONS
    // ============================================================

    /**
     * @dev Pause deposits and payments
     */
    function pause() external;

    /**
     * @dev Unpause deposits and payments
     */
    function unpause() external;

    /**
     * @dev Emergency withdraw USDC to treasury
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(uint256 amount) external;

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

    event BatchDeposited(uint256 modelCount, uint256 totalAmount);

    event BatchPaymentCompleted(uint256 paymentCount, uint256 totalAmount);

    event ProviderSet(string indexed modelId, address indexed provider);

    event EmergencyWithdrawal(address indexed recipient, uint256 amount);
}
