// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title FeeLib
 * @dev Standardized fee calculation utilities using basis points (bps)
 *
 * Basis Points (BPS): 1 bps = 0.01%, 100 bps = 1%, 10000 bps = 100%
 *
 * Benefits:
 * - Consistency: All fee calculations use same formula
 * - Testability: Single source of truth for fee math
 * - Safety: Prevents rounding errors and calculation mistakes
 * - Gas efficiency: Inline library functions have minimal overhead
 *
 * Usage:
 *   import "./libraries/FeeLib.sol";
 *
 *   (uint256 netAmount, uint256 fee) = FeeLib.applyFee(amount, 25); // 0.25% fee
 *   uint256 feeOnly = FeeLib.calculateFee(amount, 500); // 5% fee
 */
library FeeLib {
    // ============================================================
    // CONSTANTS
    // ============================================================

    /**
     * @dev Basis points denominator: 10000 = 100%
     * This means 1 bps = 0.01%, 100 bps = 1%, 10000 bps = 100%
     */
    uint256 internal constant BPS_DENOMINATOR = 10000;

    // ============================================================
    // ERRORS
    // ============================================================

    /**
     * @dev Thrown when a fee exceeds the maximum allowed
     * @param feeBps Fee that was too high
     * @param maxBps Maximum allowed fee
     */
    error FeeTooHigh(uint256 feeBps, uint256 maxBps);

    // ============================================================
    // FEE CALCULATION FUNCTIONS
    // ============================================================

    /**
     * @dev Calculate fee amount from basis points
     * @param amount Base amount to calculate fee from
     * @param feeBps Fee in basis points (e.g., 25 = 0.25%, 100 = 1%, 500 = 5%)
     * @return fee The calculated fee amount
     *
     * Formula: fee = (amount × feeBps) / 10000
     *
     * Examples:
     *   calculateFee(1000, 25)   = 2.5   (0.25% of 1000)
     *   calculateFee(1000, 100)  = 10    (1% of 1000)
     *   calculateFee(1000, 500)  = 50    (5% of 1000)
     *   calculateFee(1000, 10000) = 1000 (100% of 1000)
     */
    function calculateFee(uint256 amount, uint256 feeBps) internal pure returns (uint256 fee) {
        fee = (amount * feeBps) / BPS_DENOMINATOR;
    }

    /**
     * @dev Apply fee and return both net amount and fee separately
     * @param amount Gross amount (before fee deduction)
     * @param feeBps Fee in basis points
     * @return netAmount Amount after deducting fee (amount - fee)
     * @return fee The calculated fee amount
     *
     * Formula:
     *   fee = (amount × feeBps) / 10000
     *   netAmount = amount - fee
     *
     * Invariant: netAmount + fee = amount
     *
     * Example:
     *   applyFee(1000, 500) returns (950, 50)  // 5% fee
     *   applyFee(1000, 25)  returns (997, 3)   // 0.25% fee (rounded)
     */
    function applyFee(uint256 amount, uint256 feeBps)
        internal
        pure
        returns (uint256 netAmount, uint256 fee)
    {
        fee = calculateFee(amount, feeBps);
        netAmount = amount - fee;
    }

    /**
     * @dev Validate that a fee is within maximum bounds
     * @param feeBps Fee to validate
     * @param maxBps Maximum allowed fee in basis points
     *
     * Reverts with FeeTooHigh if feeBps > maxBps
     *
     * Example:
     *   requireValidFee(500, 1000);  // OK: 5% <= 10%
     *   requireValidFee(1500, 1000); // REVERTS: 15% > 10%
     */
    function requireValidFee(uint256 feeBps, uint256 maxBps) internal pure {
        if (feeBps > maxBps) revert FeeTooHigh(feeBps, maxBps);
    }

    /**
     * @dev Calculate percentage of an amount (generic percentage calculation)
     * @param amount Base amount
     * @param percentageBps Percentage in basis points
     * @return result Calculated percentage of amount
     *
     * This is an alias for calculateFee() with clearer semantics when not calculating fees
     *
     * Example:
     *   percentage(1000, 2000) = 200  // 20% of 1000
     */
    function percentage(uint256 amount, uint256 percentageBps)
        internal
        pure
        returns (uint256 result)
    {
        result = calculateFee(amount, percentageBps);
    }

    /**
     * @dev Split amount into protocol fee and remaining amount
     * @param amount Total amount to split
     * @param protocolFeeBps Protocol fee in basis points
     * @return protocolFee Amount allocated to protocol
     * @return remaining Amount remaining after protocol fee
     *
     * Useful for splitting fees between protocol treasury and pools
     *
     * Example:
     *   splitProtocolFee(1000, 500) returns (50, 950)  // 5% to protocol, 95% remaining
     */
    function splitProtocolFee(uint256 amount, uint256 protocolFeeBps)
        internal
        pure
        returns (uint256 protocolFee, uint256 remaining)
    {
        protocolFee = calculateFee(amount, protocolFeeBps);
        remaining = amount - protocolFee;
    }

    /**
     * @dev Calculate net amount after applying multiple sequential fees
     * @param amount Starting amount
     * @param fee1Bps First fee in basis points (applied to amount)
     * @param fee2Bps Second fee in basis points (applied to amount after fee1)
     * @return netAmount Final amount after both fees
     * @return totalFees Sum of both fees
     *
     * Example:
     *   applyMultipleFees(1000, 100, 50)
     *     fee1 = 10 (1% of 1000)
     *     fee2 = 4.95 (0.5% of 990)
     *     returns (985, 15)
     */
    function applyMultipleFees(
        uint256 amount,
        uint256 fee1Bps,
        uint256 fee2Bps
    ) internal pure returns (uint256 netAmount, uint256 totalFees) {
        uint256 fee1 = calculateFee(amount, fee1Bps);
        uint256 afterFee1 = amount - fee1;
        uint256 fee2 = calculateFee(afterFee1, fee2Bps);
        netAmount = afterFee1 - fee2;
        totalFees = fee1 + fee2;
    }
}
