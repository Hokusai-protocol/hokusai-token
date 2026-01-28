// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title ValidationLib
 * @dev Shared validation utilities to reduce code duplication across contracts
 *
 * Benefits:
 * - Gas optimization: Custom errors save ~50-100 gas per revert vs require strings
 * - Code reusability: Single source of truth for validation logic
 * - Maintainability: Updates apply to all contracts using the library
 * - Auditability: Centralized validation logic is easier to review
 *
 * Usage:
 *   import "./libraries/ValidationLib.sol";
 *
 *   ValidationLib.requireNonZeroAddress(someAddress, "token address");
 *   ValidationLib.requirePositiveAmount(amount, "deposit amount");
 */
library ValidationLib {
    // ============================================================
    // CUSTOM ERRORS (Gas-efficient vs require strings)
    // ============================================================

    /**
     * @dev Thrown when an address parameter is zero but shouldn't be
     * @param context Description of what address was being validated
     */
    error ZeroAddress(string context);

    /**
     * @dev Thrown when an amount is zero but should be positive
     * @param context Description of what amount was being validated
     */
    error InvalidAmount(string context);

    /**
     * @dev Thrown when a string parameter is empty but shouldn't be
     * @param context Description of what string was being validated
     */
    error EmptyString(string context);

    /**
     * @dev Thrown when two arrays have mismatched lengths
     * @param expected Expected array length
     * @param actual Actual array length received
     */
    error ArrayLengthMismatch(uint256 expected, uint256 actual);

    /**
     * @dev Thrown when an array is empty but shouldn't be
     */
    error ArrayEmpty();

    /**
     * @dev Thrown when a value is outside allowed bounds
     * @param value The value being validated
     * @param min Minimum allowed value (inclusive)
     * @param max Maximum allowed value (inclusive)
     */
    error ValueOutOfBounds(uint256 value, uint256 min, uint256 max);

    /**
     * @dev Thrown when array length exceeds maximum
     * @param length Actual array length
     * @param maxLength Maximum allowed length
     */
    error ArrayTooLarge(uint256 length, uint256 maxLength);

    // ============================================================
    // VALIDATION FUNCTIONS
    // ============================================================

    /**
     * @dev Validates that an address is not the zero address
     * @param addr Address to validate
     * @param context Context string for error message (e.g., "token address")
     *
     * Example:
     *   ValidationLib.requireNonZeroAddress(tokenAddress, "token address");
     */
    function requireNonZeroAddress(address addr, string memory context) internal pure {
        if (addr == address(0)) revert ZeroAddress(context);
    }

    /**
     * @dev Validates that an amount is positive (non-zero)
     * @param amount Amount to validate
     * @param context Context string for error message (e.g., "deposit amount")
     *
     * Example:
     *   ValidationLib.requirePositiveAmount(depositAmount, "deposit amount");
     */
    function requirePositiveAmount(uint256 amount, string memory context) internal pure {
        if (amount == 0) revert InvalidAmount(context);
    }

    /**
     * @dev Validates that a string is not empty
     * @param str String to validate
     * @param context Context string for error message (e.g., "model ID")
     *
     * Example:
     *   ValidationLib.requireNonEmptyString(modelId, "model ID");
     */
    function requireNonEmptyString(string memory str, string memory context) internal pure {
        if (bytes(str).length == 0) revert EmptyString(context);
    }

    /**
     * @dev Validates that two array lengths match
     * @param length1 First array length
     * @param length2 Second array length
     *
     * Example:
     *   ValidationLib.requireMatchingArrayLengths(addresses.length, amounts.length);
     */
    function requireMatchingArrayLengths(uint256 length1, uint256 length2) internal pure {
        if (length1 != length2) revert ArrayLengthMismatch(length1, length2);
    }

    /**
     * @dev Validates that an array is not empty
     * @param length Array length
     *
     * Example:
     *   ValidationLib.requireNonEmptyArray(recipients.length);
     */
    function requireNonEmptyArray(uint256 length) internal pure {
        if (length == 0) revert ArrayEmpty();
    }

    /**
     * @dev Validates that a value is within specified bounds (inclusive)
     * @param value Value to validate
     * @param min Minimum allowed value (inclusive)
     * @param max Maximum allowed value (inclusive)
     *
     * Example:
     *   ValidationLib.requireInBounds(crr, MIN_CRR, MAX_CRR);
     */
    function requireInBounds(uint256 value, uint256 min, uint256 max) internal pure {
        if (value < min || value > max) revert ValueOutOfBounds(value, min, max);
    }

    /**
     * @dev Validates that array length doesn't exceed maximum
     * @param length Array length
     * @param maxLength Maximum allowed length
     *
     * Example:
     *   ValidationLib.requireMaxArrayLength(recipients.length, 100);
     */
    function requireMaxArrayLength(uint256 length, uint256 maxLength) internal pure {
        if (length > maxLength) revert ArrayTooLarge(length, maxLength);
    }

    /**
     * @dev Combined validation for batch operations: non-empty, matching lengths, within limit
     * @param length1 First array length
     * @param length2 Second array length
     * @param maxLength Maximum allowed length
     *
     * Example:
     *   ValidationLib.requireValidBatch(addresses.length, amounts.length, 100);
     */
    function requireValidBatch(
        uint256 length1,
        uint256 length2,
        uint256 maxLength
    ) internal pure {
        requireNonEmptyArray(length1);
        requireMatchingArrayLengths(length1, length2);
        requireMaxArrayLength(length1, maxLength);
    }

    /**
     * @dev Validates that a value is less than or equal to a maximum
     * @param value The value to check
     * @param maxValue The maximum allowed value
     *
     * Example:
     *   ValidationLib.requireMaxValue(feeBps, 10000);
     */
    function requireMaxValue(uint256 value, uint256 maxValue) internal pure {
        if (value > maxValue) revert InvalidAmount("value exceeds maximum");
    }
}
